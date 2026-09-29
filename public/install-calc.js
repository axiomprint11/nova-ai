/**
 * install-calc.js — the editable installation / local delivery calculator card.
 *
 * Drawn when the server sends an `install_quote` event (tools quote_installation
 * / quote_delivery in /api/chatbot/chat). Loaded by chatbot.html and widget.html
 * after install-pricing.js. On the ChatBot page it lives in the right-hand
 * calculator pane; in the CRM widget it sits in the conversation.
 *
 * Every number comes from InstallPricing (the same file the server prices
 * with) and the rate config that arrived with the event, so what the card
 * shows is exactly what Nova said. Distance and drive time come from
 * GET /api/route (Google Maps with a key, OpenStreetMap without), always
 * measured from the Glendale shop.
 *
 *   InstallCalc.build(event, { getToken, onChange(quote) })  -> element
 *   InstallCalc.render(bubbleEl, event, opts)                  -> element
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
  function fmt0(n) { return P.money(n).replace('.00', ''); }
  function trim(n) { return String(Math.round(n * 100) / 100).replace(/\.0+$/, ''); }

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
                'September', 'October', 'November', 'December'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Schedule colours: regular green, after hours amber, Saturday purple, Sunday red.
  var SCHED = {
    weekday_business: { label: 'Regular hours', tone: 'green' },
    weekday_after:    { label: 'After hours',   tone: 'amber' },
    saturday:         { label: 'Saturday',      tone: 'purple' },
    sunday:           { label: 'Sunday',        tone: 'red' }
  };

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

  // ---- time helpers ("HH:MM", 24h) ----
  function toTime(s) {                       // "11:00 AM" -> "11:00"
    if (!s) return '';
    var m = String(s).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\.?$/i);
    if (!m) return '';
    var h = parseInt(m[1], 10), mi = m[2] || '00', ap = (m[3] || '').toLowerCase();
    if (ap === 'p' && h < 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
    return (h < 10 ? '0' : '') + h + ':' + mi;
  }
  function mins(t) { var m = String(t || '').match(/^(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; }
  function hhmm(n) { n = Math.max(0, Math.min(23 * 60 + 45, n)); var h = Math.floor(n / 60), m = n % 60; return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m; }
  function ampm(t) {
    var n = mins(t); if (n == null) return '';
    var h = Math.floor(n / 60), m = n % 60, ap = h < 12 ? 'AM' : 'PM', h12 = h % 12 || 12;
    return h12 + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
  }
  // Every 15 minutes, never every minute. A stored time off the grid is kept.
  function timeOptions(selected) {
    var out = [], seen = false;
    for (var n = 0; n < 24 * 60; n += 15) {
      var t = hhmm(n);
      if (t === selected) seen = true;
      out.push('<option value="' + t + '"' + (t === selected ? ' selected' : '') + '>' + ampm(t) + '</option>');
    }
    if (selected && !seen) out.unshift('<option value="' + selected + '" selected>' + ampm(selected) + '</option>');
    return out.join('');
  }

  // ---- date helpers (YYYY-MM-DD, shop-local) ----
  function todayISO() {
    var p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    return p;                                // en-CA gives YYYY-MM-DD
  }
  function parseISO(d) { var m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null; }
  function iso(y, m, d) { return y + '-' + (m < 9 ? '0' : '') + (m + 1) + '-' + (d < 10 ? '0' : '') + d; }
  function dow(dISO) { var p = parseISO(dISO); return p ? new Date(Date.UTC(p.y, p.m, p.d)).getUTCDay() : null; }
  function niceDate(dISO) {
    var p = parseISO(dISO); if (!p) return '';
    // The year only when it is not this year — keeps the field on one line.
    var thisYear = +todayISO().slice(0, 4);
    return DOW[dow(dISO)] + ', ' + MONTHS[p.m].slice(0, 3) + ' ' + p.d + (p.y !== thisYear ? ', ' + p.y : '');
  }

  function blankPiece() { return { name: '', w_in: '', h_in: '', qty: 1, material: '', sqft_rate: '', fixed_fee: '' }; }

  function build(ev, opts) {
    opts = opts || {};
    var getToken = opts.getToken || function () { return null; };
    var input = ev.input || {};
    var today = todayISO();
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
      route: input.route && input.route.ok ? input.route : null,
      routeMsg: '',
      routeBusy: false,
      q: null,
      ui: { pieces: null, crew: false, cal: false, calY: null, calM: null }
    };
    if (st.inst.arrival_start && !st.inst.arrival_end) st.inst.arrival_end = hhmm(mins(st.inst.arrival_start) + 30);

    var el = document.createElement('div');
    el.className = 'ic-card';
    el.setAttribute('data-kind', st.kind);

    function C() { return st.cfg.install; }

    // ------------------------------------------------------------ layout
    function paint() {
      el.innerHTML =
        '<div class="ic-head">' +
          '<div><div class="ic-eyebrow">Handling</div><h2>' + (st.kind === 'delivery' ? 'Local delivery estimate' : 'Installation estimate') + '</h2></div>' +
          '<span class="ic-seg"><button type="button" data-act="kind" data-v="installation" class="' + (st.kind === 'installation' ? 'on' : '') + '">Installation</button>' +
          '<button type="button" data-act="kind" data-v="delivery" class="' + (st.kind === 'delivery' ? 'on' : '') + '">Delivery</button></span>' +
        '</div>' +
        '<div class="ic-sum"><div><div class="ic-sum-l">Estimated price</div><div class="ic-sum-v"></div></div><span class="ic-zone"></span></div>' +
        '<div class="ic-calc">' +
          '<div class="ic-sub">Where</div>' +
          '<div class="ic-grid ic-where">' +
            field('Address', '<input type="text" data-k="address" value="' + esc(st.address) + '" placeholder="Street, place or city">') +
            field('Miles (one way)', '<input type="number" min="0" step="0.1" data-k="distance_mi" value="' + esc(st.distance_mi) + '" placeholder="auto">') +
          '</div>' +
          '<div class="ic-route"></div>' +
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
    function money(k, v, ph) {
      return '<div class="ic-money"><span>$</span><input type="number" min="0" step="0.01" data-k="' + k + '" value="' + esc(v) + '" placeholder="' + esc(ph) + '"></div>';
    }
    function chev() {
      return '<svg class="ic-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    }

    function installInputs() {
      var I = st.inst, c = C();
      var ins = c.insurance.map(function (o) {
        var cur = I.insurance || c.default_insurance;
        return '<option value="' + esc(o.id) + '"' + (cur === o.id ? ' selected' : '') + '>' + esc(o.label) + ' — ' + esc(fmt0(o.amount)) + (o.editable ? '+' : '') + '</option>';
      }).join('');
      var insOpt = c.insurance.filter(function (o) { return o.id === (I.insurance || c.default_insurance); })[0];
      var hasPiece = I.pieces.some(function (p) { return parseFloat(p.w_in) > 0 && parseFloat(p.h_in) > 0; });
      if (st.ui.pieces === null) st.ui.pieces = !hasPiece;       // open only when there is nothing to show

      return '' +
        '<div class="ic-sub">When</div>' +
        '<div class="ic-grid three">' +
          '<div class="ic-f">Install date' + dateField() + '</div>' +
          field('Arrive from', '<select data-k="arrival_start"><option value="">—</option>' + timeOptions(I.arrival_start) + '</select>') +
          field('Arrive by', '<select data-k="arrival_end"><option value="">—</option>' + timeOptions(I.arrival_end) + '</select>') +
        '</div>' +
        '<div class="ic-sched"></div>' +

        '<details class="ic-acc" data-acc="pieces"' + (st.ui.pieces ? ' open' : '') + '>' +
          '<summary><span class="ic-acc-t">Pieces</span><span class="ic-acc-m ic-pc-meta"></span>' +
          '<b class="ic-acc-v ic-pc-amt"></b>' + chev() + '</summary>' +
          '<div class="ic-acc-b">' +
            '<div class="ic-pieces">' + I.pieces.map(pieceRow).join('') + '</div>' +
            '<button type="button" class="ic-btn small ic-addp" data-act="add">+ Add piece</button>' +
          '</div>' +
        '</details>' +

        '<div class="ic-sub">Equipment</div>' +
        '<div class="ic-checks">' + (c.equipment.length ? c.equipment.map(function (e) {
          var on = I.equipment.indexOf(e.id) > -1;
          return '<label class="ic-check' + (on ? ' on' : '') + '"><input type="checkbox" data-eq="' + esc(e.id) + '"' + (on ? ' checked' : '') + '>' +
            esc(e.label) + ' <small>' + esc(fmt0(e.fee)) + '</small></label>';
        }).join('') : '<span class="ic-f">No equipment set up in Admin</span>') + '</div>' +

        '<div class="ic-grid">' +
          field('Insurance', '<select data-k="insurance">' + ins + '</select>', insOpt && insOpt.editable ? '' : 'ic-span2') +
          (insOpt && insOpt.editable ? field('Insurance amount', money('insurance_amount', I.insurance_amount || insOpt.amount, insOpt.amount)) : '') +
        '</div>' +

        '<details class="ic-acc" data-acc="crew"' + (st.ui.crew ? ' open' : '') + '>' +
          '<summary><span class="ic-acc-t">Crew &amp; hours</span><span class="ic-acc-m ic-crew-meta"></span>' +
          '<b class="ic-acc-v ic-crew-amt"></b>' + chev() + '</summary>' +
          '<div class="ic-acc-b"><div class="ic-grid three">' +
            field('Installers', '<input type="number" min="1" step="1" data-k="crew" value="' + esc(I.crew) + '" placeholder="auto">') +
            field('Hours on site', '<input type="number" min="0.5" step="0.5" data-k="hours" value="' + esc(I.hours) + '" placeholder="auto">') +
            field('Installer $/hr', money('hourly', I.hourly, c.hourly)) +
          '</div><div class="ic-crew-why"></div></div>' +
        '</details>';
    }

    function dateField() {
      var I = st.inst, d = I.date;
      var tone = d ? (dow(d) === 0 ? 'red' : dow(d) === 6 ? 'purple' : 'green') : '';
      return '<div class="ic-datewrap">' +
        '<button type="button" class="ic-datebtn' + (d ? '' : ' empty') + '" data-act="cal">' +
          (d ? '<span class="ic-dot ic-t-' + tone + '"></span>' + esc(niceDate(d)) : 'Pick a date') +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>' +
        '</button>' +
        (st.ui.cal ? calendar() : '') +
      '</div>';
    }

    function calendar() {
      var sel = parseISO(st.inst.date), t = parseISO(today);
      if (st.ui.calY == null) { var base = sel || t; st.ui.calY = base.y; st.ui.calM = base.m; }
      var y = st.ui.calY, m = st.ui.calM;
      var first = new Date(Date.UTC(y, m, 1)).getUTCDay();
      var days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      var cells = '';
      for (var i = 0; i < first; i++) cells += '<span></span>';
      for (var d = 1; d <= days; d++) {
        var k = iso(y, m, d), w = (first + d - 1) % 7;
        var past = k < today;
        var cls = 'ic-day' + (w === 6 ? ' sat' : w === 0 ? ' sun' : '') + (k === today ? ' today' : '') +
                  (k === st.inst.date ? ' sel' : '') + (past ? ' past' : '');
        cells += '<button type="button" class="' + cls + '" data-act="day" data-v="' + k + '"' + (past ? ' disabled' : '') + '>' + d + '</button>';
      }
      var prevDisabled = (y < t.y) || (y === t.y && m <= t.m);
      return '<div class="ic-cal" role="dialog" aria-label="Pick an install date">' +
        '<div class="ic-cal-h"><button type="button" data-act="calprev"' + (prevDisabled ? ' disabled' : '') + '>‹</button>' +
        '<b>' + MONTHS[m] + ' ' + y + '</b><button type="button" data-act="calnext">›</button></div>' +
        '<div class="ic-cal-w">' + DOW.map(function (x, i) { return '<span class="' + (i === 0 ? 'sun' : i === 6 ? 'sat' : '') + '">' + x.charAt(0) + '</span>'; }).join('') + '</div>' +
        '<div class="ic-cal-g">' + cells + '</div>' +
        '<div class="ic-cal-f"><span class="ic-leg"><i class="ic-t-green"></i>Weekday</span><span class="ic-leg"><i class="ic-t-purple"></i>Sat</span>' +
        '<span class="ic-leg"><i class="ic-t-red"></i>Sun</span><span style="flex:1"></span>' +
        '<button type="button" data-act="day" data-v="' + today + '">Today</button>' +
        (st.inst.date ? '<button type="button" data-act="day" data-v="">Clear</button>' : '') + '</div>' +
      '</div>';
    }

    function pieceRow(p, i) {
      var c = C();
      var mats = '<option value="">Material — assume Level 1</option>' + c.materials.map(function (m) {
        var lv = c.levels.filter(function (l) { return Number(l.id) === Number(m.level); })[0];
        return '<option value="' + esc(m.id) + '"' + (p.material === m.id ? ' selected' : '') + '>' + esc(m.label) +
          (lv ? ' · ' + esc(fmt0(lv.rate)) + '/sq ft' : '') + '</option>';
      }).join('');
      var rateAuto = P.rateForMaterial(p.material || c.default_material, st.cfg);
      var need = function (v) { return v === '' || v == null ? ' ic-need' : ''; };
      return '<div class="ic-piece" data-p="' + i + '">' +
        field('Piece', '<input type="text" data-pk="name" value="' + esc(p.name) + '" placeholder="Piece ' + (i + 1) + '">') +
        field('Material', '<select data-pk="material">' + mats + '</select>') +
        '<div class="ic-piece-dims">' +
          field('W (in)', '<input type="number" min="0" step="0.01" data-pk="w_in" class="' + need(p.w_in) + '" value="' + esc(p.w_in) + '">') +
          field('H (in)', '<input type="number" min="0" step="0.01" data-pk="h_in" class="' + need(p.h_in) + '" value="' + esc(p.h_in) + '">') +
          field('Qty', '<input type="number" min="1" step="1" data-pk="qty" value="' + esc(p.qty) + '">') +
          field('$/sq ft', '<input type="number" min="0" step="0.01" data-pk="sqft_rate" value="' + esc(p.sqft_rate) + '" placeholder="' + esc(rateAuto) + '">') +
          field('Fixed $', '<input type="number" min="0" step="0.01" data-pk="fixed_fee" value="' + esc(p.fixed_fee) + '" placeholder="' + esc(c.fixed_fee) + '">') +
          '<button type="button" class="ic-x" data-act="rm" title="Remove piece"' + (st.inst.pieces.length < 2 ? ' disabled style="visibility:hidden"' : '') + '>&times;</button>' +
        '</div>' +
        '<div class="ic-piece-meta"><span class="ic-pm-sqft"></span><b class="ic-pm-amt"></b></div>' +
      '</div>';
    }

    function deliveryInputs() {
      var D = st.cfg.delivery, d = st.del;
      return '<div class="ic-sub">When</div>' +
        '<div class="ic-grid three">' +
        field('Drop-off time', '<select data-k="drop_time"><option value="">—</option>' + timeOptions(d.drop_time) + '</select>') +
        field('Traffic', '<select data-k="traffic"><option value="">Auto — from time</option>' + D.traffic.map(function (t) {
          return '<option value="' + esc(t.id) + '"' + (d.traffic === t.id ? ' selected' : '') + '>' + esc(t.label.split(' (')[0]) + ' × ' + esc(t.factor) + '</option>';
        }).join('') + '</select>') +
        field('Drive min (one way)', '<input type="number" min="0" step="1" data-k="minutes_one_way" value="' + esc(d.minutes_one_way) + '" placeholder="auto">') +
      '</div>';
    }

    // ------------------------------------------------------------ compute
    function effectiveSchedule() {
      var I = st.inst;
      if (I.date) return null;                                   // engine works it out from the date
      if (I.schedule) return I.schedule;
      // No date and nothing picked, but the arrival window is outside business hours.
      var bh = C().business_hours, s = mins(I.arrival_start), e = mins(I.arrival_end);
      if (s != null && (s < mins(bh.start) || s >= mins(bh.end) || (e != null && e > mins(bh.end)))) return 'weekday_after';
      return null;
    }

    function currentInput() {
      if (st.kind === 'delivery') {
        return { address: st.address, distance_mi: st.distance_mi, drop_time: st.del.drop_time,
                 traffic: st.del.traffic || null, minutes_one_way: st.del.minutes_one_way, route: st.route };
      }
      var I = st.inst;
      return {
        address: st.address, distance_mi: st.distance_mi, route: st.route,
        pieces: I.pieces.map(function (p) {
          return { name: p.name, w_in: p.w_in, h_in: p.h_in, qty: p.qty, material: p.material || null,
                   sqft_rate: p.sqft_rate, fixed_fee: p.fixed_fee };
        }),
        equipment: I.equipment, insurance: I.insurance || null, insurance_amount: I.insurance_amount,
        date: I.date, arrival_start: I.arrival_start, arrival_end: I.arrival_end,
        schedule: effectiveSchedule(), crew: I.crew, hours: I.hours, hourly: I.hourly, height_ft: I.height_ft
      };
    }

    function recompute() {
      var q = st.kind === 'delivery' ? P.quoteDelivery(currentInput(), st.cfg) : P.quoteInstall(currentInput(), st.cfg);
      st.q = q;
      var set = function (sel, html) { var n = el.querySelector(sel); if (n) n.innerHTML = html; };

      set('.ic-sum-v', q.total == null ? 'Hand off' : esc(fmt(q.total)) + (q.provisional ? ' <span class="ic-prov">Provisional</span>' : ''));
      var z = q.zone;
      set('.ic-zone', z ? '<span class="ic-chip ic-tone-' + esc(z.tone) + '" title="' + esc(z.guidance) + '"><span class="ic-bullet"></span>' +
        esc(trim(q.inputs.distance_mi)) + ' mi · ' + esc(z.label) + '</span>' : '');
      var dEl = el.querySelector('[data-k="distance_mi"]');
      if (dEl) dEl.classList.toggle('ic-need', st.distance_mi === '' && !st.routeBusy);
      renderRoute(q);

      if (st.kind === 'installation') {
        renderSchedule(q);
        // pieces
        var rows = el.querySelectorAll('.ic-piece'), qp = q.inputs.pieces, k = 0;
        st.inst.pieces.forEach(function (p, i) {
          var row = rows[i]; if (!row) return;
          var ok = parseFloat(p.w_in) > 0 && parseFloat(p.h_in) > 0;
          var r = ok ? qp[k++] : null;
          row.querySelector('.ic-pm-sqft').textContent = r ? trim(r.sqft) + ' sq ft · ' + r.material_label : 'Enter width and height';
          row.querySelector('.ic-pm-amt').textContent = r ? fmt(r.amount) : '';
          var rate = row.querySelector('[data-pk="sqft_rate"]');
          if (rate) rate.placeholder = P.rateForMaterial(p.material || st.cfg.install.default_material, st.cfg);
        });
        var b = q.breakdown;
        set('.ic-pc-meta', b.piece_count
          ? b.piece_count + (b.piece_count === 1 ? ' piece' : ' pieces') + ' · ' + trim(b.sqft) + ' sq ft'
          : '<span class="ic-warnt">Add sizes</span>');
        set('.ic-pc-amt', b.piece_count ? esc(fmt(b.sqft_charge + b.fixed)) : '');
        // crew: the one-line proposal
        var hourly = st.inst.hourly !== '' ? Number(st.inst.hourly) : C().hourly;
        var manual = st.inst.crew !== '' || st.inst.hours !== '';
        set('.ic-crew-meta', (manual ? 'Set: ' : 'Proposed: ') + b.crew + (b.crew === 1 ? ' installer' : ' installers') +
          ' · ' + trim(b.hours) + (b.hours === 1 ? ' hr' : ' hrs') + ' · ' + esc(fmt0(hourly)) + '/hr' +
          (b.multiplier > 1 ? ' × ' + trim(b.multiplier) : ''));
        set('.ic-crew-amt', b.labor ? esc(fmt(b.labor)) : '');
        set('.ic-crew-why', b.crew_reasons.length || b.rig_hrs
          ? esc([b.crew_reasons.length ? 'Crew raised to 2: ' + b.crew_reasons.join(', ') : '',
                 b.rig_hrs ? 'includes ' + trim(b.rig_hrs) + ' hr rig time' : ''].filter(Boolean).join(' · ')) : '');
        var cr = el.querySelector('[data-k="crew"]'), hr = el.querySelector('[data-k="hours"]');
        if (cr && !st.inst.crew) cr.placeholder = 'auto · ' + b.crew;
        if (hr && !st.inst.hours) hr.placeholder = 'auto · ' + trim(b.hours);
      }

      set('.ic-lines', q.lines.length
        ? q.lines.map(function (l) { return '<div class="ic-line"><span>' + esc(l.label) + '</span><b>' + esc(fmt(l.amount)) + '</b></div>'; }).join('')
        : '<div class="ic-line"><span>Add piece sizes to price the job</span></div>');
      set('.ic-total', '<b>Total</b><b>' + (q.total == null ? 'Hand off' : esc(fmt(q.total))) + '</b>');

      var notes = '<div class="ic-note info"><span>' + (q.assumptions.length ? 'Assumes ' + esc(q.assumptions.join(' · ')) + '.' : 'Every input given — no assumptions.') + '</span>' +
        '<span class="ic-tip" tabindex="0"><span class="ic-qmark">?</span><span class="ic-bubble">' + esc(rulesText()) + '</span></span></div>';
      q.warnings.forEach(function (w) { notes += '<div class="ic-note warn"><span>' + esc(w) + '</span></div>'; });
      set('.ic-notes', notes);
      if (typeof opts.onChange === 'function') { try { opts.onChange(q); } catch (e) {} }
    }

    function renderRoute(q) {
      var box = el.querySelector('.ic-route');
      if (!box) return;
      var origin = (st.cfg.origin || '').replace(/^AxiomPrint,\s*/i, '').split(',')[0];
      if (st.routeBusy) { box.className = 'ic-route busy'; box.innerHTML = '<span class="ic-spin"></span>Measuring the drive from ' + esc(origin) + '…'; return; }
      if (st.routeMsg) { box.className = 'ic-route bad'; box.innerHTML = esc(st.routeMsg); return; }
      var r = st.route;
      if (!r) {
        box.className = 'ic-route';
        box.innerHTML = st.address ? '' : 'Miles and drive time are measured from ' + esc(origin) + ' when you enter an address.';
        return;
      }
      if (r.source === 'shop') { box.className = 'ic-route ok'; box.innerHTML = 'At the shop — no travel.'; return; }
      var drive = q.drive && q.drive.minutes != null ? q.drive.minutes : null;
      var trafficName = st.kind === 'delivery'
        ? ((st.cfg.delivery.traffic.filter(function (t) { return t.id === q.inputs.traffic; })[0] || {}).label || '')
        : ((st.cfg.delivery.traffic.filter(function (t) { return t.id === (q.drive && q.drive.traffic); })[0] || {}).label || '');
      trafficName = trafficName.split(' (')[0].toLowerCase();
      var manualMiles = st.distance_mi !== '' && Number(st.distance_mi) !== Number(r.miles);
      box.className = 'ic-route ok';
      box.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.1-7-11a7 7 0 1 1 14 0c0 4.9-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>' +
        '<span><b>' + esc(trim(r.miles)) + ' mi</b> from ' + esc(origin) +
        ' · ' + esc(r.minutes) + ' min drive' +
        (drive != null ? ' · <b>~' + drive + ' min</b> in ' + (q.drive.live ? 'predicted traffic' : esc(trafficName) + ' traffic') : '') +
        (manualMiles ? ' · <i>using ' + esc(trim(st.distance_mi)) + ' mi you entered</i>' : '') +
        '</span><span class="ic-src" title="' + esc(r.matched || '') + '">' + (r.source === 'google' ? 'Google Maps' : 'OpenStreetMap') + (r.approximate ? ' · approx.' : '') + '</span>';
    }

    function renderSchedule(q) {
      var box = el.querySelector('.ic-sched');
      if (!box) return;
      var S = C().surcharge, fromDate = !!st.inst.date, cur = q.inputs.schedule;
      var mult = { weekday_business: 1, weekday_after: S.after_hours_mult, saturday: S.saturday_mult, sunday: S.sunday_mult };
      box.innerHTML = Object.keys(SCHED).map(function (id) {
        var on = cur === id;
        return '<button type="button" class="ic-pill ic-t-' + SCHED[id].tone + (on ? ' on' : '') + '" data-act="sched" data-v="' + id + '"' +
          (fromDate && !on ? ' disabled' : '') + '><span class="ic-dot"></span>' + SCHED[id].label +
          '<small>' + (mult[id] > 1 ? trim(mult[id]) + '× labor + ' + fmt0(S.callout_fee) : 'standard') + '</small></button>';
      }).join('') +
      '<div class="ic-sched-h">' + (fromDate ? 'Set by the date and arrival time.' : 'No date yet — pick the kind of day.') + '</div>';
    }

    function rulesText() {
      var c = st.cfg.install, D = st.cfg.delivery;
      if (st.kind === 'delivery') {
        return 'Mileage ' + fmt(D.mile_rate) + '/mi one way + ' + fmt(D.base_fee) + ' base + driver time both ways at ' +
          fmt(D.driver_hourly) + '/hr. Drive time comes from the map route × traffic (' +
          D.traffic.map(function (t) { return t.label.split(' (')[0].toLowerCase() + ' ×' + t.factor; }).join(', ') +
          '); with no route, miles ÷ ' + D.avg_mph + ' mph.';
      }
      var steps = c.crew.steps.map(function (s) { return s.crew + ' to ' + s.max_sqft + ' sq ft'; }).join(' · ');
      return c.hours.sqft_per_installer_hour + ' sq ft per installer per hour · ' + steps + ' · max ' + c.crew.max +
        '. Hours = ' + c.hours.setup + ' setup + ' + c.hours.per_piece + ' per piece + area + rig time, rounded to ' + c.hours.round_to +
        '. ' + fmt0(c.minimum) + ' minimum · after hours or Saturday ' + c.surcharge.after_hours_mult + '× labor, Sunday ' +
        c.surcharge.sunday_mult + '×, plus ' + fmt0(c.surcharge.callout_fee) + ' call-out · mileage ' + fmt(c.mile_rate) +
        '/mi billed both ways. Crew drive time is shown, not billed.';
    }

    // ------------------------------------------------------------ route lookup
    var routeTimer = null, routeSeq = 0;
    function measure() {
      var addr = String(st.address || '').trim();
      clearTimeout(routeTimer);
      if (addr.length < 4) { st.route = null; st.routeMsg = ''; recompute(); return; }
      var seq = ++routeSeq;
      st.routeBusy = true; st.routeMsg = ''; recompute();
      var t = st.kind === 'delivery' ? st.del.drop_time : st.inst.arrival_start;
      fetch('/api/route?address=' + encodeURIComponent(addr) + '&date=' + encodeURIComponent(st.inst.date || '') +
            '&time=' + encodeURIComponent(t || ''), { headers: { 'Authorization': 'Bearer ' + getToken() } })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (seq !== routeSeq) return;
          st.routeBusy = false;
          if (j && j.ok) { st.route = j; st.routeMsg = ''; st.distance_mi = j.miles; }
          else { st.route = null; st.routeMsg = (j && j.error) || 'Could not measure that address — enter the miles by hand.'; }
          var d = el.querySelector('[data-k="distance_mi"]'); if (d) d.value = st.distance_mi;
          recompute();
        })
        .catch(function () {
          if (seq !== routeSeq) return;
          st.routeBusy = false; st.routeMsg = 'Could not reach the distance service — enter the miles by hand.'; recompute();
        });
    }
    // Google predicts traffic for a specific time, so a new date/time is worth
    // asking again. OpenStreetMap's road time does not change with the clock.
    function remeasureIfLive() { if (st.route && st.route.source === 'google') measure(); }

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
        var id = t.getAttribute('data-eq'), list = st.inst.equipment, at = list.indexOf(id);
        if (t.checked && at < 0) list.push(id);
        if (!t.checked && at > -1) list.splice(at, 1);
        t.closest('.ic-check').classList.toggle('on', t.checked);
        recompute();
      } else if (t.hasAttribute('data-k')) {
        var k = t.getAttribute('data-k');
        if (k === 'address') {
          st.address = t.value;
          clearTimeout(routeTimer);
          if (e.type === 'change') measure();                 // left the field
          else routeTimer = setTimeout(measure, 1100);        // paused typing
          return;
        }
        if (k === 'distance_mi') { st.distance_mi = t.value; recompute(); return; }
        if (st.kind === 'delivery') {
          st.del[k] = t.value;
          if (k === 'drop_time' && e.type === 'change') remeasureIfLive();
          recompute(); return;
        }
        st.inst[k] = t.value;
        if (k === 'arrival_start' && e.type === 'change') {
          // Arrival window is 30 minutes unless someone widens it.
          st.inst.arrival_end = t.value ? hhmm(mins(t.value) + 30) : '';
          var endSel = el.querySelector('[data-k="arrival_end"]');
          if (endSel) endSel.innerHTML = '<option value="">—</option>' + timeOptions(st.inst.arrival_end);
          remeasureIfLive();
        }
        if (k === 'insurance' && e.type === 'change') { st.inst.insurance_amount = ''; paint(); return; }
        recompute();
      }
    }

    // Accordions remember whether they are open across repaints.
    el.addEventListener('toggle', function (e) {
      var d = e.target;
      if (d && d.getAttribute && d.getAttribute('data-acc')) st.ui[d.getAttribute('data-acc')] = d.open;
    }, true);

    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b || !el.contains(b)) return;
      var act = b.getAttribute('data-act');
      if (act === 'kind') {
        var k = b.getAttribute('data-v');
        if (k !== st.kind) { st.kind = k; el.setAttribute('data-kind', k); paint(); }
      } else if (act === 'add') {
        st.inst.pieces.push(blankPiece()); st.ui.pieces = true; paint();
        var rows = el.querySelectorAll('.ic-piece'), last = rows[rows.length - 1];
        if (last) { var w = last.querySelector('[data-pk="w_in"]'); if (w) w.focus(); }
      } else if (act === 'rm') {
        st.inst.pieces.splice(parseInt(b.closest('.ic-piece').getAttribute('data-p'), 10), 1);
        if (!st.inst.pieces.length) st.inst.pieces.push(blankPiece());
        paint();
      } else if (act === 'cal') {
        st.ui.cal = !st.ui.cal; st.ui.calY = null; paintDate();
      } else if (act === 'calprev' || act === 'calnext') {
        st.ui.calM += act === 'calnext' ? 1 : -1;
        if (st.ui.calM > 11) { st.ui.calM = 0; st.ui.calY++; }
        if (st.ui.calM < 0) { st.ui.calM = 11; st.ui.calY--; }
        paintDate();
      } else if (act === 'day') {
        st.inst.date = b.getAttribute('data-v') || '';
        if (st.inst.date) st.inst.schedule = '';
        st.ui.cal = false; paintDate(); recompute(); remeasureIfLive();
      } else if (act === 'sched') {
        if (st.inst.date) return;
        var v = b.getAttribute('data-v');
        st.inst.schedule = st.inst.schedule === v ? '' : v;
        recompute();
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
    // Close the calendar on a click anywhere else.
    document.addEventListener('mousedown', function (e) {
      if (!st.ui.cal || !el.isConnected) return;
      var w = el.querySelector('.ic-datewrap');
      if (w && !w.contains(e.target)) { st.ui.cal = false; paintDate(); }
    });
    function paintDate() {
      var w = el.querySelector('.ic-datewrap');
      if (w) w.outerHTML = dateField();
    }

    if (st.hasCfg) {
      paint();
      // A card from the chat with an address the server could not measure, or a
      // fresh one typed by hand: measure now.
      if (st.address && !st.route && st.distance_mi === '') measure();
    } else {
      // No rates arrived with the card — never price on guessed rates.
      el.innerHTML = '<div class="ic-note">Loading installation rates…</div>';
      fetchLiveConfig(getToken).then(function (cfg) { st.cfg = P.withDefaults(cfg); st.hasCfg = true; paint(); })
        .catch(function (e) { el.innerHTML = '<div class="ic-note bad">Could not load installation rates: ' + esc(e.message) + '</div>'; });
    }
    el.__installQuote = function () { return st.q; };
    return el;
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }

  // Draw into a chat bubble (used where there is no side pane). A later card in
  // the same answer replaces the earlier one, so there are never two totals.
  function render(box, ev, opts) {
    if (ev && ev.replace) box.querySelectorAll('.ic-card').forEach(function (n) { n.remove(); });
    var card = build(ev || {}, opts);
    box.appendChild(card);
    return card;
  }

  global.InstallCalc = { build: build, render: render };
})(window);
