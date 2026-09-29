/**
 * nova-report.js — draws a Nova report (reports.js on the server) two ways:
 *
 *   compact card  — in the ChatBot page's right pane or inline in the CRM
 *                   widget: headline numbers and the top rows.
 *   full view     — a full-screen page over Nova with every control, summary
 *                   card, filter, sortable column, Copy emails and CSV.
 *
 * Both share one state, so changing a setting in the full view updates the
 * card too. Changing a report setting re-runs it (POST /api/reports/:id);
 * search, filters and sorting happen in the browser.
 *
 *   NovaReport.build(event, { getToken, onChange(result) }) -> card element
 *   NovaReport.render(bubbleEl, event, opts)                -> card element
 *
 * `event` is the SSE `report` event: { report, params, result? }. A card
 * reopened from a saved chat has no result and fetches it.
 */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money0 = n => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const int = n => Number(n || 0).toLocaleString('en-US');
  const us = d => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[2] + '-' + m[3] + '-' + m[1] : ''; };
  const dayMs = s => { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; };
  const initials = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
  const AVATAR = ['#4f46e5', '#7c3aed', '#0891b2', '#c2410c', '#15803d', '#be185d', '#0f766e', '#a16207'];
  function fmtSummary(s) { return s.fmt === 'money' ? money0(s.value) : s.fmt === 'pct' ? s.value + '%' : int(s.value); }

  const ICON = {
    expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    csv: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'
  };
  const svg = k => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICON[k] + '</svg>';

  // ---------------------------------------------------------------- cells
  function asOfMs(st) { return dayMs(st.result && (st.result.as_of || st.result.params.as_of)) || Date.now(); }
  function cell(col, row, st) {
    const v = row[col.key];
    const none = '<span class="nr-muted">' + esc(col.empty || '—') + '</span>';
    switch (col.type) {
      case 'client': {
        const i = Math.abs(String(row.client_id || row.name).split('').reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7)) % AVATAR.length;
        return '<div class="nr-client"><span class="nr-av" style="background:' + AVATAR[i] + '">' + esc(initials(row.name)) + '</span>' +
          '<span><span class="nr-cn">' + esc(row.name) + '</span>' +
          (row.email ? '<a class="nr-ce" href="mailto:' + esc(row.email) + '">' + esc(row.email) + '</a>' : '') + '</span></div>';
      }
      case 'text_strong': return v ? '<b>' + esc(v) + '</b>' : none;
      case 'text': return v !== '' && v != null ? esc(v) : none;
      case 'int': return v == null ? none : int(v);
      case 'money': return v == null ? none : money(v);
      case 'date': return v ? us(v) : none;
      case 'date_ago': {
        if (!v) return none;
        const days = Math.round((asOfMs(st) - dayMs(v)) / 864e5);
        return us(v) + '<div class="nr-sub">' + days + ' day' + (days === 1 ? '' : 's') + ' ago</div>';
      }
      case 'score': {
        const band = v == null ? 'na' : v >= 7 ? 'hi' : v >= 4 ? 'mid' : 'lo';
        return '<span class="nr-score nr-s-' + band + '">' + (v == null ? '–' : esc(v)) + '</span>';
      }
      case 'engagement': {
        const e = row.engagement || {};
        const t = e.touches || {};
        const tip = 'Inbound: ' + (t.call_in || 0) + ' calls, ' + (t.email_in || 0) + ' emails. Outbound: ' +
          (t.call_out || 0) + ' calls, ' + (t.email_out || 0) + ' emails.';
        const sub = (e.calls || 0) + (e.emails || 0) === 0 ? 'No contact'
          : e.calls + ' call' + (e.calls === 1 ? '' : 's') + ', ' + e.emails + ' email' + (e.emails === 1 ? '' : 's');
        return '<div class="nr-eng" title="' + esc(tip) + '"><div class="nr-eng-top"><span class="nr-bar' + (e.high ? ' hot' : '') + '"><i style="width:' +
          ((e.score || 0) * 10) + '%"></i></span><b>' + (e.score || 0) + '</b></div><span class="nr-sub">' + sub + '</span>' +
          (e.high ? '<span class="nr-flag' + (e.action === 'Train' ? ' train' : '') + '">High touch — ' + esc(String(e.action).toLowerCase()) + '</span>' : '') + '</div>';
      }
      case 'bar_pct':
        return '<div class="nr-pct"><span class="nr-bar"><i style="width:' + Math.min(100, (v || 0) * (100 / Math.max(1, st.maxShare || 100))) + '%"></i></span>' + (v || 0) + '%</div>';
      case 'age': {
        const band = row.age_band || (v <= 0 ? 'current' : v <= 30 ? '1_30' : v <= 60 ? '31_60' : v <= 90 ? '61_90' : '90_plus');
        return '<span class="nr-chip nr-age-' + band + '">' + (v <= 0 ? 'Not due' : v + ' days') + '</span>';
      }
      case 'status':
        return '<span class="nr-chip nr-st-' + esc(v) + '">' + esc(v === 'partial' ? 'Partly paid' : String(v || '').replace(/^./, c => c.toUpperCase())) + '</span>';
      default: return v == null ? none : esc(v);
    }
  }
  const isRight = c => c.type === 'money' || c.align === 'right';

  // ---------------------------------------------------------------- data
  function visibleRows(st) {
    const r = st.result;
    if (!r) return [];
    const q = st.q.trim().toLowerCase();
    const keys = r.search_keys || ['name'];
    let rows = r.rows.filter(row => {
      for (const f of r.filters || []) {
        const want = st.filters[f.key];
        if (!want) continue;
        const have = row[f.field];
        if (Array.isArray(have) ? have.indexOf(want) < 0 : String(have) !== want) return false;
      }
      return !q || keys.some(k => String(row[k] || '').toLowerCase().indexOf(q) > -1);
    });
    const k = st.sort.key, dir = st.sort.dir === 'asc' ? 1 : -1;
    const val = x => { const v = x[k]; return v == null || v === '' ? null : typeof v === 'string' ? v.toLowerCase() : v; };
    return rows.sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1; if (vb === null) return -1;          // blanks always sink
      return va > vb ? dir : va < vb ? -dir : 0;
    });
  }

  // ---------------------------------------------------------------- build
  function build(ev, opts) {
    opts = opts || {};
    const getToken = opts.getToken || (() => null);
    const st = { id: ev.report, params: Object.assign({}, ev.params || {}), result: ev.result || null,
                 loading: !ev.result, error: '', q: '', filters: {}, sort: { key: '', dir: 'desc' }, full: null };
    if (st.result) adopt(st.result);

    const card = document.createElement('div');
    card.className = 'nr nr-card';

    function adopt(res) {
      st.result = res;
      st.params = Object.assign({}, res.params);
      if (!st.sort.key || !res.columns.some(c => c.key === st.sort.key)) st.sort = Object.assign({}, res.sort || { key: res.columns[0].key, dir: 'desc' });
      st.maxShare = Math.max(1, ...res.rows.map(r => r.share || 0));
    }

    function rerun() {
      st.loading = true; st.error = '';
      paintAll();
      fetch('/api/reports/' + encodeURIComponent(st.id), {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
        body: JSON.stringify({ params: st.params })
      }).then(r => r.json()).then(j => {
        st.loading = false;
        if (!j.success) { st.error = j.error || 'The report could not run.'; paintAll(); return; }
        adopt(j.report);
        paintAll();
        if (typeof opts.onChange === 'function') { try { opts.onChange(st.result); } catch (e) {} }
      }).catch(e => { st.loading = false; st.error = 'Could not reach Nova: ' + e.message; paintAll(); });
    }

    function paintAll() { paintCard(); if (st.full) paintFull(); }

    // ---- compact card ----
    function paintCard() {
      const r = st.result;
      if (!r) {
        card.innerHTML = '<div class="nr-head"><div><div class="nr-eyebrow">Report</div><h2>' + esc(title()) + '</h2></div></div>' +
          (st.error ? '<div class="nr-note bad">' + esc(st.error) + '</div>' : '<div class="nr-loading"><span class="nr-spin"></span>Running the report…</div>');
        return;
      }
      const rows = visibleRows(st);
      const cols = r.columns.filter(c => c.compact);
      const top = rows.slice(0, 8);
      card.innerHTML =
        '<div class="nr-head"><div><div class="nr-eyebrow">Report' + (st.loading ? ' · updating…' : '') + '</div><h2>' + esc(r.title) + '</h2></div>' +
          '<button type="button" class="nr-btn primary small" data-act="full">' + svg('expand') + 'Full view</button></div>' +
        '<div class="nr-range">' + (r.range ? r.range.html + (r.range.note ? ' <span class="nr-muted">— ' + esc(r.range.note) + '</span>' : '') : '') + '</div>' +
        '<div class="nr-tiles">' + r.summary.slice(0, 4).map(s =>
          '<div class="nr-tile nr-tone-' + esc(s.tone) + '"><span>' + esc(s.label) + '</span><b>' + esc(fmtSummary(s)) + '</b></div>').join('') + '</div>' +
        (rows.length
          ? '<div class="nr-mini"><table><thead><tr>' + cols.map(c => '<th class="' + (isRight(c) ? 'r' : '') + '">' + esc(c.label) + '</th>').join('') + '</tr></thead><tbody>' +
            top.map(row => '<tr>' + cols.map(c => '<td class="' + (isRight(c) ? 'r' : '') + '">' + cell(c, row, st) + '</td>').join('') + '</tr>').join('') +
            '</tbody></table></div>'
          : '<div class="nr-empty">Nothing matches these settings.</div>') +
        '<div class="nr-foot"><span class="nr-muted">' + (rows.length > top.length ? 'Top ' + top.length + ' of ' + int(rows.length) : int(rows.length) + ' row' + (rows.length === 1 ? '' : 's')) + '</span>' +
          (r.email_key ? '<button type="button" class="nr-btn small" data-act="copy">' + svg('copy') + 'Copy emails</button>' : '') +
          '<button type="button" class="nr-btn small" data-act="full">Open full report</button></div>' +
        (r.notes && r.notes.length ? '<div class="nr-note warn">' + esc(r.notes[0]) + '</div>' : '');
    }

    function title() { return (st.result && st.result.title) || ({ client_followup: 'Client Follow-up', top_clients: 'Top Clients',
      unpaid_invoices: 'Unpaid Invoices', product_sales: 'Product Sales' }[st.id] || 'Report'); }

    // ---- full view ----
    function openFull() {
      if (st.full) return;
      const ov = document.createElement('div');
      ov.className = 'nr nr-full';
      ov.setAttribute('role', 'dialog');
      ov.setAttribute('aria-label', title());
      document.body.appendChild(ov);
      st.full = ov;
      document.documentElement.classList.add('nr-lock');
      ov.addEventListener('click', onClick);
      ov.addEventListener('input', onInput);
      ov.addEventListener('change', onInput);
      paintFull();
      const s = ov.querySelector('.nr-search input'); if (s) s.focus({ preventScroll: true });
    }
    function closeFull() {
      if (!st.full) return;
      st.full.remove(); st.full = null;
      document.documentElement.classList.remove('nr-lock');
    }
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && st.full) closeFull(); });

    function controlHtml(c) {
      if (c.show_if && Object.keys(c.show_if).some(k => String(st.params[k]) !== String(c.show_if[k]))) return '';
      if (c.type === 'date') {
        return '<span class="nr-ctl-label">' + esc(c.label) + '</span><div class="nr-pills"><input type="date" class="nr-in" data-p="' + esc(c.key) + '" value="' + esc(c.value || '') + '"></div>';
      }
      const cur = String(c.value);
      let html = '<span class="nr-ctl-label">' + esc(c.label) + '</span><div class="nr-pills" role="group">' +
        c.options.map(o => '<button type="button" class="nr-pill" data-p="' + esc(c.key) + '" data-v="' + esc(o.v) + '" aria-pressed="' + (String(o.v) === cur) + '">' + esc(o.l) + '</button>').join('');
      if (c.custom && cur === 'custom') {
        html += '<span class="nr-custom"><input type="number" class="nr-in nr-num" data-p="' + esc(c.custom.key) + '" min="' + (c.custom.min || 1) + '" max="' + (c.custom.max || 999) +
          '" value="' + esc(c.custom.value) + '">' +
          (c.custom.unit
            ? '<select class="nr-in" data-p="' + esc(c.custom.unit.key) + '">' + c.custom.unit.options.map(o => '<option value="' + esc(o.v) + '"' + (o.v === c.custom.unit.value ? ' selected' : '') + '>' + esc(o.l) + '</option>').join('') + '</select>'
            : '<span>' + esc(c.custom.suffix || '') + '</span>') + '</span>';
      }
      return html + '</div>';
    }

    function paintFull() {
      const ov = st.full; if (!ov) return;
      const r = st.result;
      const keepSearch = document.activeElement && document.activeElement.closest && document.activeElement.closest('.nr-search');
      const top = '<div class="nr-bar-top"><button type="button" class="nr-btn ghost" data-act="close">' + svg('back') + 'Back to chat</button>' +
        '<div class="nr-bar-t"><span class="nr-eyebrow">Nova report</span><b>' + esc(title()) + '</b></div>' +
        '<button type="button" class="nr-x" data-act="close" aria-label="Close">' + svg('close') + '</button></div>';
      if (!r) {
        ov.innerHTML = top + '<div class="nr-page">' + (st.error ? '<div class="nr-note bad">' + esc(st.error) + '</div>' : '<div class="nr-loading"><span class="nr-spin"></span>Running the report…</div>') + '</div>';
        return;
      }
      const rows = visibleRows(st);
      const main = r.controls.filter(c => c.place !== 'range');
      const side = r.controls.filter(c => c.place === 'range');
      const filters = (r.filters || []).map(f => {
        const opts2 = f.from_rows
          ? [...new Set(r.rows.map(x => x[f.field]).filter(Boolean))].sort().map(v => ({ v: v, l: v }))
          : f.options;
        return '<select class="nr-in" data-f="' + esc(f.key) + '"><option value="">' + esc(f.label) + '</option>' +
          opts2.map(o => '<option value="' + esc(o.v) + '"' + (st.filters[f.key] === String(o.v) ? ' selected' : '') + '>' + esc(o.l) + '</option>').join('') + '</select>';
      }).join('');
      ov.innerHTML = top +
        '<div class="nr-page">' +
          '<div class="nr-hero"><h1>' + esc(r.title) + '</h1><p>' + esc(r.subtitle || '') + '</p></div>' +
          '<section class="nr-panel">' +
            '<div class="nr-controls">' + main.map(controlHtml).join('') + '</div>' +
            '<div class="nr-strip"><div class="nr-range-l">' + (r.range ? r.range.html + (r.range.note ? ' <span class="nr-muted">— ' + esc(r.range.note) + '</span>' : '') : '') + '</div>' +
              side.map(c => '<label class="nr-asof">' + esc(c.label) + ' <input type="date" class="nr-in" data-p="' + esc(c.key) + '" value="' + esc(c.value || '') + '"></label>').join('') +
              (st.loading ? '<span class="nr-upd"><span class="nr-spin"></span>Updating</span>' : '') + '</div>' +
            (st.error ? '<div class="nr-note bad">' + esc(st.error) + '</div>' : '') +
            (r.notes || []).map(n => '<div class="nr-note warn">' + esc(n) + '</div>').join('') +
            (r.method ? '<details class="nr-method"><summary>How this report is calculated</summary><p>' + esc(r.method) + '</p></details>' : '') +
          '</section>' +
          '<div class="nr-cards">' + r.summary.map(s =>
            '<div class="nr-scard nr-tone-' + esc(s.tone) + '"><span>' + esc(s.label) + '</span><b>' + esc(fmtSummary(s)) + '</b></div>').join('') + '</div>' +
          '<section class="nr-tablewrap">' +
            '<div class="nr-tools"><h2>' + esc(r.title.replace(/ Report$/, '')) + ' list</h2>' +
              '<label class="nr-search">' + svg('search') + '<input type="search" placeholder="Search…" value="' + esc(st.q) + '" data-q="1"></label>' +
              filters +
              (r.email_key ? '<button type="button" class="nr-btn" data-act="copy">' + svg('copy') + 'Copy emails</button>' : '') +
              '<button type="button" class="nr-btn" data-act="csv">' + svg('csv') + 'CSV</button>' +
              '<span class="nr-count">' + int(rows.length) + ' of ' + int(r.rows.length) + '</span></div>' +
            '<div class="nr-scroll"><table class="nr-table"><thead><tr>' + r.columns.map(c => {
              const cls = isRight(c) ? 'r' : '';
              if (!c.sort) return '<th class="' + cls + '">' + esc(c.label) + '</th>';
              const on = st.sort.key === c.key;
              return '<th class="' + cls + (on ? ' on' : '') + '" aria-sort="' + (on ? (st.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none') +
                '"><button type="button" data-sort="' + esc(c.key) + '">' + esc(c.label) + '<span>' + (on ? (st.sort.dir === 'asc' ? '↑' : '↓') : '↕') + '</span></button></th>';
            }).join('') + '</tr></thead><tbody>' +
            (rows.length ? rows.map(row => '<tr>' + r.columns.map(c => '<td class="' + (isRight(c) ? 'r' : '') + '">' + cell(c, row, st) + '</td>').join('') + '</tr>').join('')
              : '<tr><td colspan="' + r.columns.length + '" class="nr-empty">Nothing matches. Try a wider window, a different period, or clear the filters.</td></tr>') +
            '</tbody></table></div>' +
            (r.truncated ? '<div class="nr-note warn">This report hit its row limit — narrow the settings to see everything.</div>' : '') +
          '</section>' +
        '</div>';
      if (keepSearch) {
        const s = ov.querySelector('.nr-search input');
        if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
      }
    }

    // ---- actions ----
    function copyEmails(btn) {
      const r = st.result; if (!r || !r.email_key) return;
      const list = [...new Set(visibleRows(st).map(x => String(x[r.email_key] || '').trim()).filter(Boolean))];
      const text = list.join(', ');
      const done = () => { const o = btn.innerHTML; btn.textContent = 'Copied ' + list.length + ' emails'; setTimeout(() => { btn.innerHTML = o; }, 1800); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => { fallbackCopy(text); done(); });
      else { fallbackCopy(text); done(); }
    }
    function csv() {
      const r = st.result; if (!r) return;
      const cols = [];
      r.columns.forEach(c => {
        if (c.type === 'client') { cols.push({ h: 'Name', f: x => x.name }); cols.push({ h: 'Email', f: x => x.email }); }
        else if (c.type === 'engagement') { cols.push({ h: 'Engagement', f: x => x.engagement && x.engagement.score });
          cols.push({ h: 'High touch', f: x => x.engagement && x.engagement.high ? x.engagement.action : '' }); }
        else cols.push({ h: c.label, f: x => x[c.key] });
      });
      const q = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const text = [cols.map(c => q(c.h)).join(',')].concat(visibleRows(st).map(x => cols.map(c => q(c.f(x))).join(','))).join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
      a.download = r.id + '-' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    }

    function onClick(e) {
      const b = e.target.closest('[data-act],[data-sort],.nr-pill');
      if (!b) return;
      if (b.dataset.act === 'full') openFull();
      else if (b.dataset.act === 'close') closeFull();
      else if (b.dataset.act === 'copy') copyEmails(b);
      else if (b.dataset.act === 'csv') csv();
      else if (b.dataset.sort) {
        const k = b.dataset.sort;
        const textCol = (st.result.columns.find(c => c.key === k) || {}).type;
        st.sort = st.sort.key === k ? { key: k, dir: st.sort.dir === 'asc' ? 'desc' : 'asc' }
          : { key: k, dir: /^(client|text|text_strong)$/.test(textCol) ? 'asc' : 'desc' };
        paintAll();
      } else if (b.classList.contains('nr-pill')) {
        const k = b.dataset.p, v = b.dataset.v;
        if (String(st.params[k]) === v && v !== 'custom') return;
        st.params[k] = /^\d+$/.test(v) ? Number(v) : v;
        if (v === 'custom') { if (st.full) paintFull(); if (st.id !== 'client_followup' || k !== 'months') { /* custom inputs appear; run with current values */ } }
        rerun();
      }
    }
    let typeTimer = null;
    function onInput(e) {
      const t = e.target;
      if (t.dataset.q) { st.q = t.value; paintAll(); return; }
      if (t.dataset.f) { st.filters[t.dataset.f] = t.value; paintAll(); return; }
      if (t.dataset.p) {
        if (t.type === 'number' && e.type === 'input') {         // wait for the typing to stop
          clearTimeout(typeTimer);
          typeTimer = setTimeout(() => { st.params[t.dataset.p] = Number(t.value) || 1; rerun(); }, 600);
          return;
        }
        if (e.type !== 'change') return;
        st.params[t.dataset.p] = t.value;
        rerun();
      }
    }
    card.addEventListener('click', onClick);

    paintCard();
    if (!st.result) rerun();
    card.__novaReport = { open: openFull, result: () => st.result };
    return card;
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }

  // Inline (no side pane). A second report in the same answer replaces the first.
  function render(box, ev, opts) {
    if (ev && ev.replace) box.querySelectorAll('.nr-card').forEach(n => n.remove());
    const card = build(ev || {}, opts);
    box.appendChild(card);
    return card;
  }

  // What to keep with a saved chat message: the settings, not the rows — the
  // rows are re-run on reopen, and a big report would not fit in the message.
  function toSaved(ev) { return { type: 'report', report: ev.report, params: ev.params, replace: ev.replace }; }

  global.NovaReport = { build: build, render: render, toSaved: toSaved };
})(window);
