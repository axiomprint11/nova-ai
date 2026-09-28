/**
 * install-calc.js — the editable installation / local delivery calculator card.
 *
 * Drawn in a chat answer when the server sends an `install_quote` event
 * (tools quote_installation / quote_delivery in /api/chatbot/chat). Loaded by
 * chatbot.html and widget.html after install-pricing.js.
 *
 * Every number comes from InstallPricing (the same file the server prices
 * with) and the rate config that arrived with the event, so what the card
 * shows is exactly what Nova said. "Latest rates" re-reads Admin's current
 * rates for a card from an older conversation.
 *
 *   InstallCalc.render(bubbleEl, event, { getToken })
 */
(function (global) {
  'use strict';
  var P = global.InstallPricing;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function val(v) { return v == null ? '' : v; }
  function fmt(n) { return P.money(n); }
  function trim(n) { return String(Math.round(n * 100) / 100).replace(/\.0+$/, ''); }

  var liveCfgPromise = null;
  function fetchLiveConfig(getToken) {
    if (!liveCfgPromise) {
      liveCfgPromise = fetch('/api/install-pricing', { headers: { 'Authorization': 'Bearer ' + getToken() } })
        .then(function (r) { return r.json(); })
        .then(function (j) { if (!j.success) throw new Error(j.error || 'Could not load rates'); return j.config; })
        .catch(function (e) { liveCfgPromise = null; throw e; });
    }
    return liveCfgPromise;
  }

  function blankPiece() { return { name: '', w_in: '', h_in: '', qty: 1, material: '', sqft_rate: '', fixed_fee: '' }; }

  function build(ev, opts) {
    opts = opts || {};
    var getToken = opts.getToken || function () { return null; };
    var input = ev.input || {};
    var st = {
      kind: ev.kind === 'delivery' ? 'delivery' : 'installation',
      cfg: P.withDefaults(ev.config || null),
      hasCfg: !!ev.config,
      inst: {
        pieces: (input.pieces && input.pieces.length ? input.pieces : [blankPiece()]).map(function (p) {
          return { name: val(p.name), w_in: val(p.w_in), h_in: val(p.h_in), qty: val(p.qty || 1),
                   material: val(p.material), sqft_rate: val(p.sqft_rate), fixed_fee: val(p.fixed_fee) };
        }),
        date: val(input.date), arrival_start: toTime(input.arrival_start), arrival_end: toTime(input.arrival_end),
        schedule: val(input.schedule), equipment: (input.equipment || []).slice(),
        insurance: val(input.insurance), insurance_amount: val(input.insurance_amount),
        crew: '', hours: '', hourly: '', height_ft: val(input.height_ft)
      },
      del: { drop_time: toTime(input.drop_time), traffic: val(input.traffic), minutes_one_way: '' },
      address: val(input.address),
      distance_mi: val(input.distance_mi),
      q: null
    };

    var el = document.createElement('div');
    el.className = 'ic-card';
    el.setAttribute('data-kind', st.kind);

    function cfgI() { return st.cfg.install; }

    // ------------------------------------------------------------ inputs
    function paint() {
      el.innerHTML =
        '<div class="ic-head">' +
          '<div><div class="ic-eyebrow">Handling</div><h2>' + (st.kind === 'delivery' ? 'Local delivery estimate' : 'Installation estimate') + '</h2></div>' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
            '<span class="ic-zone"></span>' +
            '<span class="ic-seg"><button type="button" data-act="kind" data-v="installation" class="' + (st.kind === 'installation' ? 'on' : '') + '">Installation</button>' +
            '<button type="button" data-act="kind" data-v="delivery" class="' + (st.kind === 'delivery' ? 'on' : '') + '">Delivery</button></span>' +
          '</div>' +
        '</div>' +
        '<div class="ic-calc">' +
          '<div class="ic-grid">' +
            field('Address', '<input type="text" data-k="address" value="' + esc(st.address) + '" placeholder="Where it goes">') +
            field('Distance (mi, one way)', '<input type="number" min="0" step="0.1" data-k="distance_mi" value="' + esc(st.distance_mi) + '" placeholder="From Glendale shop">') +
          '</div>' +
          (st.kind === 'delivery' ? deliveryInputs() : installInputs()) +
        '</div>' +
        '<div class="ic-calc ic-out"><div class="ic-lines"></div><div class="ic-total"></div></div>' +
        '<div class="ic-notes"></div>' +
        '<div class="ic-actions">' +
          '<button type="button" class="ic-btn small" data-act="live" title="Re-read the rates set in Admin → Installation Pricing">Latest rates</button>' +
          '<button type="button" class="ic-btn small primary" data-act="copy">Copy quote</button>' +
        '</div>';
      recompute();
    }

    function field(label, inner, cls) {
      return '<label class="ic-f' + (cls ? ' ' + cls : '') + '">' + esc(label) + inner + '</label>';
    }
    function money(k, v, ph, attrs) {
      return '<div class="ic-money"><span>$</span><input type="number" min="0" step="0.01" data-k="' + k + '" value="' + esc(v) + '" placeholder="' + esc(ph) + '"' + (attrs || '') + '></div>';
    }

    function installInputs() {
      var C = cfgI(), I = st.inst;
      var sch = '<select data-k="schedule"><option value="">Auto — from date</option>' +
        ['weekday_business', 'weekday_after', 'saturday', 'sunday'].map(function (s) {
          return '<option value="' + s + '"' + (I.schedule === s ? ' selected' : '') + '>' + esc(P.SCHEDULE_LABEL[s]) + '</option>';
        }).join('') + '</select>';
      var ins = C.insurance.map(function (o) {
        var cur = I.insurance || C.default_insurance;
        return '<option value="' + esc(o.id) + '"' + (cur === o.id ? ' selected' : '') + '>' + esc(o.label) + ' — ' + esc(fmt(o.amount).replace('.00', '')) + (o.editable ? '+' : '') + '</option>';
      }).join('');
      var insOpt = C.insurance.filter(function (o) { return o.id === (I.insurance || C.default_insurance); })[0];
      return '' +
        '<div class="ic-sub">Pieces <button type="button" class="ic-btn small" data-act="add">+ Add piece</button></div>' +
        '<div class="ic-pieces">' + I.pieces.map(pieceRow).join('') + '</div>' +
        '<div class="ic-sub">Equipment</div>' +
        '<div class="ic-checks">' + (C.equipment.length ? C.equipment.map(function (e) {
          var on = I.equipment.indexOf(e.id) > -1;
          return '<label class="ic-check' + (on ? ' on' : '') + '"><input type="checkbox" data-eq="' + esc(e.id) + '"' + (on ? ' checked' : '') + '>' +
            esc(e.label) + ' <small>' + esc(fmt(e.fee).replace('.00', '')) + '</small></label>';
        }).join('') : '<span class="ic-f">No equipment set up in Admin</span>') + '</div>' +
        '<div class="ic-grid three">' +
          field('Install date', '<input type="date" data-k="date" value="' + esc(I.date) + '">') +
          field('Arrive from', '<input type="time" data-k="arrival_start" value="' + esc(I.arrival_start) + '">') +
          field('Arrive by', '<input type="time" data-k="arrival_end" value="' + esc(I.arrival_end) + '">') +
        '</div>' +
        '<div class="ic-grid">' +
          field('Schedule', sch) +
          field('Insurance', '<select data-k="insurance">' + ins + '</select>') +
          (insOpt && insOpt.editable ? field('Insurance amount', money('insurance_amount', I.insurance_amount || insOpt.amount, insOpt.amount), 'ic-span2') : '') +
        '</div>' +
        '<details class="ic-adv"><summary>Crew, hours &amp; rate</summary><div class="ic-grid three">' +
          field('Installers', '<input type="number" min="1" step="1" data-k="crew" value="' + esc(I.crew) + '" placeholder="auto">') +
          field('Hours on site', '<input type="number" min="0.5" step="0.5" data-k="hours" value="' + esc(I.hours) + '" placeholder="auto">') +
          field('Installer $/hr', money('hourly', I.hourly, C.hourly)) +
        '</div></details>';
    }

    function pieceRow(p, i) {
      var C = cfgI();
      var mats = '<option value="">Material — assume Level 1</option>' + C.materials.map(function (m) {
        var lv = C.levels.filter(function (l) { return Number(l.id) === Number(m.level); })[0];
        return '<option value="' + esc(m.id) + '"' + (p.material === m.id ? ' selected' : '') + '>' + esc(m.label) +
          (lv ? ' · ' + esc(fmt(lv.rate).replace('.00', '')) + '/sq ft' : '') + '</option>';
      }).join('');
      var rateAuto = P.rateForMaterial(p.material || C.default_material, st.cfg);
      var need = function (v) { return v === '' || v == null ? ' ic-need' : ''; };
      return '<div class="ic-piece" data-p="' + i + '">' +
        field('Piece', '<input type="text" data-pk="name" value="' + esc(p.name) + '" placeholder="Piece ' + (i + 1) + '">') +
        field('Material', '<select data-pk="material">' + mats + '</select>') +
        '<div class="ic-piece-dims">' +
          field('W (in)', '<input type="number" min="0" step="0.01" data-pk="w_in" class="' + need(p.w_in) + '" value="' + esc(p.w_in) + '">') +
          field('H (in)', '<input type="number" min="0" step="0.01" data-pk="h_in" class="' + need(p.h_in) + '" value="' + esc(p.h_in) + '">') +
          field('Qty', '<input type="number" min="1" step="1" data-pk="qty" value="' + esc(p.qty) + '">') +
          field('$/sq ft', '<input type="number" min="0" step="0.01" data-pk="sqft_rate" value="' + esc(p.sqft_rate) + '" placeholder="' + esc(rateAuto) + '">') +
          field('Fixed $', '<input type="number" min="0" step="0.01" data-pk="fixed_fee" value="' + esc(p.fixed_fee) + '" placeholder="' + esc(C.fixed_fee) + '">') +
          '<button type="button" class="ic-x" data-act="rm" title="Remove piece"' + (st.inst.pieces.length < 2 ? ' disabled style="visibility:hidden"' : '') + '>&times;</button>' +
        '</div>' +
        '<div class="ic-piece-meta"><span class="ic-pm-sqft"></span><b class="ic-pm-amt"></b></div>' +
      '</div>';
    }

    function deliveryInputs() {
      var D = st.cfg.delivery, d = st.del;
      return '<div class="ic-grid three">' +
        field('Drop-off time', '<input type="time" data-k="drop_time" value="' + esc(d.drop_time) + '">') +
        field('Traffic', '<select data-k="traffic"><option value="">Auto — from time</option>' + D.traffic.map(function (t) {
          return '<option value="' + esc(t.id) + '"' + (d.traffic === t.id ? ' selected' : '') + '>' + esc(t.label) + ' × ' + esc(t.factor) + '</option>';
        }).join('') + '</select>') +
        field('Drive min (one way)', '<input type="number" min="0" step="1" data-k="minutes_one_way" value="' + esc(d.minutes_one_way) + '" placeholder="auto">') +
      '</div>';
    }

    // ------------------------------------------------------------ compute
    function currentInput() {
      if (st.kind === 'delivery') {
        return { address: st.address, distance_mi: st.distance_mi, drop_time: st.del.drop_time,
                 traffic: st.del.traffic || null, minutes_one_way: st.del.minutes_one_way };
      }
      var I = st.inst;
      return {
        address: st.address, distance_mi: st.distance_mi,
        pieces: I.pieces.map(function (p) {
          return { name: p.name, w_in: p.w_in, h_in: p.h_in, qty: p.qty, material: p.material || null,
                   sqft_rate: p.sqft_rate, fixed_fee: p.fixed_fee };
        }),
        equipment: I.equipment, insurance: I.insurance || null, insurance_amount: I.insurance_amount,
        date: I.date, arrival_start: I.arrival_start, arrival_end: I.arrival_end,
        schedule: I.schedule || null, crew: I.crew, hours: I.hours, hourly: I.hourly, height_ft: I.height_ft
      };
    }

    function recompute() {
      var inp = currentInput();
      var q = st.kind === 'delivery' ? P.quoteDelivery(inp, st.cfg) : P.quoteInstall(inp, st.cfg);
      st.q = q;

      // zone chip
      var z = q.zone, zEl = el.querySelector('.ic-zone');
      if (zEl) zEl.innerHTML = z
        ? '<span class="ic-chip ic-tone-' + esc(z.tone) + '" title="' + esc(z.guidance) + '"><span class="ic-bullet"></span>' + esc(trim(q.inputs.distance_mi)) + ' mi · ' + esc(z.label) + '</span>'
        : '';
      var dEl = el.querySelector('[data-k="distance_mi"]');
      if (dEl) dEl.classList.toggle('ic-need', st.distance_mi === '');

      // per-piece subtotals and auto placeholders
      if (st.kind === 'installation') {
        var rows = el.querySelectorAll('.ic-piece');
        var qp = q.inputs.pieces, k = 0;
        st.inst.pieces.forEach(function (p, i) {
          var row = rows[i]; if (!row) return;
          var ok = parseFloat(p.w_in) > 0 && parseFloat(p.h_in) > 0;
          var r = ok ? qp[k++] : null;
          row.querySelector('.ic-pm-sqft').textContent = r ? trim(r.sqft) + ' sq ft · ' + r.material_label : 'Enter width and height';
          row.querySelector('.ic-pm-amt').textContent = r ? fmt(r.amount) : '';
          var rate = row.querySelector('[data-pk="sqft_rate"]');
          if (rate) rate.placeholder = P.rateForMaterial(p.material || st.cfg.install.default_material, st.cfg);
        });
        var cr = el.querySelector('[data-k="crew"]'), hr = el.querySelector('[data-k="hours"]');
        if (cr && !st.inst.crew) cr.placeholder = 'auto · ' + q.breakdown.crew;
        if (hr && !st.inst.hours) hr.placeholder = 'auto · ' + trim(q.breakdown.hours);
      }

      // lines + total
      el.querySelector('.ic-lines').innerHTML = q.lines.length
        ? q.lines.map(function (l) { return '<div class="ic-line"><span>' + esc(l.label) + '</span><b>' + esc(fmt(l.amount)) + '</b></div>'; }).join('')
        : '<div class="ic-line"><span>Add piece sizes to price the job</span></div>';
      el.querySelector('.ic-total').innerHTML = '<b>Total' + (q.provisional ? '<span class="ic-prov">Provisional</span>' : '') + '</b>' +
        '<b>' + (q.total == null ? 'Hand off' : esc(fmt(q.total))) + '</b>';

      // notes
      var notes = '';
      {
        notes += '<div class="ic-note info"><span>' + (q.assumptions.length ? 'Assumes ' + esc(q.assumptions.join(' · ')) + '.' : 'Every input given — no assumptions.') + '</span>' +
          '<span class="ic-tip" tabindex="0"><span class="ic-qmark">?</span><span class="ic-bubble">' + esc(rulesText()) + '</span></span></div>';
      }
      q.warnings.forEach(function (w) { notes += '<div class="ic-note warn"><span>' + esc(w) + '</span></div>'; });
      el.querySelector('.ic-notes').innerHTML = notes;
    }

    function rulesText() {
      var C = st.cfg.install, D = st.cfg.delivery;
      if (st.kind === 'delivery') {
        return 'Mileage ' + fmt(D.mile_rate) + '/mi one way + ' + fmt(D.base_fee) + ' base + driver time both ways at ' +
          fmt(D.driver_hourly) + '/hr. Drive time = miles ÷ ' + D.avg_mph + ' mph × traffic (' +
          D.traffic.map(function (t) { return t.label.split(' (')[0].toLowerCase() + ' ×' + t.factor; }).join(', ') + ').';
      }
      var steps = C.crew.steps.map(function (s) { return s.crew + ' to ' + s.max_sqft + ' sq ft'; }).join(' · ');
      return C.hours.sqft_per_installer_hour + ' sq ft per installer per hour · ' + steps + ' · max ' + C.crew.max +
        '. Hours = ' + C.hours.setup + ' setup + ' + C.hours.per_piece + ' per piece + area + rig time, rounded to ' + C.hours.round_to +
        '. ' + fmt(C.minimum).replace('.00', '') + ' minimum · after hours or Saturday ' + C.surcharge.after_hours_mult + '× labor, Sunday ' +
        C.surcharge.sunday_mult + '×, plus ' + fmt(C.surcharge.callout_fee).replace('.00', '') + ' call-out · mileage ' + fmt(C.mile_rate) + '/mi billed both ways.';
    }

    // ------------------------------------------------------------ events
    el.addEventListener('input', onEdit);
    el.addEventListener('change', onEdit);
    function onEdit(e) {
      var t = e.target;
      if (t.hasAttribute('data-pk')) {
        var row = t.closest('.ic-piece'), i = parseInt(row.getAttribute('data-p'), 10);
        st.inst.pieces[i][t.getAttribute('data-pk')] = t.value;
        if (t.getAttribute('data-pk') === 'w_in' || t.getAttribute('data-pk') === 'h_in') t.classList.toggle('ic-need', t.value === '');
        recompute();
      } else if (t.hasAttribute('data-eq')) {
        if (e.type !== 'change') return;
        var id = t.getAttribute('data-eq'), list = st.inst.equipment;
        var at = list.indexOf(id);
        if (t.checked && at < 0) list.push(id);
        if (!t.checked && at > -1) list.splice(at, 1);
        t.closest('.ic-check').classList.toggle('on', t.checked);
        recompute();
      } else if (t.hasAttribute('data-k')) {
        var k = t.getAttribute('data-k');
        if (k === 'address' || k === 'distance_mi') st[k] = t.value;
        else if (st.kind === 'delivery') st.del[k] = t.value;
        else st.inst[k] = t.value;
        // Changing the insurance option decides whether its amount box shows.
        if (k === 'insurance' && e.type === 'change') { st.inst.insurance_amount = ''; paint(); return; }
        recompute();
      }
    }

    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b || !el.contains(b)) return;
      var act = b.getAttribute('data-act');
      if (act === 'kind') {
        var k = b.getAttribute('data-v');
        if (k !== st.kind) { st.kind = k; el.setAttribute('data-kind', k); paint(); }
      } else if (act === 'add') {
        st.inst.pieces.push(blankPiece()); paint();
        var rows = el.querySelectorAll('.ic-piece');
        var last = rows[rows.length - 1];
        if (last) { var w = last.querySelector('[data-pk="w_in"]'); if (w) w.focus(); }
      } else if (act === 'rm') {
        var row = b.closest('.ic-piece');
        st.inst.pieces.splice(parseInt(row.getAttribute('data-p'), 10), 1);
        if (!st.inst.pieces.length) st.inst.pieces.push(blankPiece());
        paint();
      } else if (act === 'copy') {
        var text = P.toText(st.q);
        var done = function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy quote'; }, 1400); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
        else { fallbackCopy(text); done(); }
      } else if (act === 'live') {
        b.textContent = 'Loading…';
        liveCfgPromise = null;
        fetchLiveConfig(getToken).then(function (cfg) {
          var before = st.q && st.q.total;
          st.cfg = P.withDefaults(cfg); st.hasCfg = true;
          paint();
          var after = st.q && st.q.total;
          var btn = el.querySelector('[data-act="live"]');
          if (btn) btn.textContent = before === after ? 'Rates are current' : 'Updated from ' + (before == null ? '—' : fmt(before));
        }).catch(function () { b.textContent = 'Could not load rates'; });
      }
    });

    if (st.hasCfg) paint();
    else {
      // No rates arrived with the card — never price on guessed rates.
      el.innerHTML = '<div class="ic-note">Loading installation rates…</div>';
      fetchLiveConfig(getToken).then(function (cfg) { st.cfg = P.withDefaults(cfg); st.hasCfg = true; paint(); })
        .catch(function (e) { el.innerHTML = '<div class="ic-note bad">Could not load installation rates: ' + esc(e.message) + '</div>'; });
    }
    return el;
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }

  // "11:00 AM" → "11:00" for <input type=time>
  function toTime(s) {
    if (!s) return '';
    var m = String(s).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\.?$/i);
    if (!m) return '';
    var h = parseInt(m[1], 10), mi = m[2] || '00', ap = (m[3] || '').toLowerCase();
    if (ap === 'p' && h < 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
    return (h < 10 ? '0' : '') + h + ':' + mi;
  }

  // Draw into a chat bubble. A later card in the same answer replaces the
  // earlier one, so the answer never shows two different totals.
  function render(box, ev, opts) {
    if (ev && ev.replace) box.querySelectorAll('.ic-card').forEach(function (n) { n.remove(); });
    var card = build(ev || {}, opts);
    box.appendChild(card);
    return card;
  }

  global.InstallCalc = { build: build, render: render };
})(window);
