/**
 * install-pricing.js — installation & local delivery pricing.
 *
 * ONE implementation, loaded by BOTH sides:
 *   server:  const InstallPricing = require('./public/install-pricing.js');
 *   browser: <script src="/install-pricing.js"></script>  → window.InstallPricing
 *
 * The product pricing engine is duplicated server/browser and has to be kept in
 * sync by hand. This one is deliberately not: the number Nova says in chat and
 * the number the calculator card shows come from the same function, fed the
 * same admin-edited rates (SQLite `install_pricing`, edited in Admin →
 * Installation Pricing).
 *
 * Every number lives in the config. Nothing below should contain a price.
 * Source of the rules: docs/install-pricing-training.md.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InstallPricing = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- defaults
  // What the training document specifies. Admin edits are stored as a full copy
  // of this object and merged over it, so a key added here later still has a
  // value on a box whose saved config predates it.
  var DEFAULTS = {
    version: 1,
    install: {
      fixed_fee: 20,                 // $ per piece, handling
      hourly: 35,                    // $ per installer-hour
      levels: [
        { id: 1, label: 'Level 1', rate: 2 },
        { id: 2, label: 'Level 2', rate: 3 },
        { id: 3, label: 'Level 3', rate: 5 }
      ],
      materials: [
        { id: 'vinyl',   label: 'Vinyl decal (matte / gloss)',       level: 1 },
        { id: 'rigid',   label: 'Rigid panel (foamcore, PVC)',       level: 1 },
        { id: 'banner',  label: 'Banner / canvas',                   level: 1 },
        { id: 'perf',    label: 'Perforated window film',            level: 2 },
        { id: 'frost',   label: 'Frosted / etched film',             level: 2 },
        { id: 'floor',   label: 'Floor graphic (laminated)',         level: 2 },
        { id: 'wallfab', label: 'Wall fabric / textured wall',       level: 3 },
        { id: 'acm',     label: 'ACM / aluminum panel',              level: 3 },
        { id: 'letters', label: 'Dimensional letters',               level: 3 }
      ],
      default_material: 'vinyl',
      crew: {
        // total sq ft at or under each step → that many installers
        steps: [ { max_sqft: 200, crew: 1 }, { max_sqft: 800, crew: 2 }, { max_sqft: 2400, crew: 3 } ],
        max: 4,
        oversize_side_in: 96,        // any piece with a side this long needs 2
        oversize_sqft: 30            // or any single piece this big
      },
      hours: {
        setup: 0.5,
        per_piece: 0.25,
        sqft_per_installer_hour: 100,
        round_to: 0.5,
        minimum: 1
      },
      equipment: [
        { id: 'h14',    label: 'Ladder — up to 14 ft',              fee: 40,  rig_hrs: 0.5,  forces_two: true,  max_height_ft: 14 },
        { id: 'h18',    label: 'Tall ladder — 14 to 18 ft',         fee: 120, rig_hrs: 0.75, forces_two: true,  max_height_ft: 18 },
        { id: 'h35',    label: 'Crane / bucket lift — 18 to 35 ft', fee: 450, rig_hrs: 1.5,  forces_two: true,  max_height_ft: 35, crane: true },
        { id: 'survey', label: 'Pre-install survey',                fee: 200, rig_hrs: 0,    forces_two: false }
      ],
      max_height_ft: 35,             // above this Nova does not quote
      insurance: [
        { id: 'waived', label: 'Waived',                  amount: 0 },
        { id: 'std',    label: 'Liability, up to $100K',  amount: 75 },
        { id: 'extra',  label: 'Extra insurance',         amount: 250, editable: true }
      ],
      default_insurance: 'std',
      mile_rate: 2,                  // $ per mile, billed round trip
      handoff_miles: 100,            // past this, flag travel day / per diem
      business_hours: { start: '08:00', end: '18:00' },   // Mon–Fri
      surcharge: {
        after_hours_mult: 1.5,
        saturday_mult: 1.5,
        sunday_mult: 2,
        callout_fee: 150             // once per job
      },
      minimum: 150
    },
    delivery: {
      mile_rate: 2,                  // one way
      base_fee: 10,
      driver_hourly: 25,             // billed both ways
      avg_mph: 22,
      traffic: [
        { id: 'off',  label: 'Off-peak (early or evening)', factor: 1.0 },
        { id: 'mid',  label: 'Midday',                      factor: 1.3 },
        { id: 'peak', label: 'Peak (7–10 AM, 3–7 PM)',      factor: 1.9 }
      ],
      default_traffic: 'mid',
      peak_windows: [ ['07:00', '10:00'], ['15:00', '19:00'] ],
      offpeak_before: '07:00',
      offpeak_after: '19:00'
    },
    zones: [
      { zone: 1, max_mi: 10,  tone: 'green',  label: 'Zone 1', guidance: 'Driver run, cheapest option' },
      { zone: 2, max_mi: 25,  tone: 'amber',  label: 'Zone 2', guidance: 'Driver still beats a carrier' },
      { zone: 3, max_mi: 50,  tone: 'purple', label: 'Zone 3', guidance: 'Compare driver against a carrier' },
      { zone: 4, max_mi: null, tone: 'grey',  label: 'Zone 4', guidance: 'Ship it; delivery is the wrong tool' }
    ],
    origin: 'AxiomPrint, 4544 San Fernando Rd., Glendale, CA 91204'
  };

  // ---------------------------------------------------------------- helpers
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  // Saved config over defaults. Arrays are taken whole from the saved copy
  // (an admin who removed a material meant it), objects merge key by key.
  function merge(base, over) {
    if (!isObj(over)) return clone(base);
    var out = clone(base);
    Object.keys(over).forEach(function (k) {
      if (isObj(base[k]) && isObj(over[k])) out[k] = merge(base[k], over[k]);
      else if (over[k] !== undefined && over[k] !== null) out[k] = clone(over[k]);
    });
    return out;
  }
  function withDefaults(cfg) { return merge(DEFAULTS, cfg || {}); }
  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }
  function cents(n) { return Math.round(n * 100) / 100; }
  function money(n) {
    return '$' + cents(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function hm(s) {                     // "08:00" | "8:00 AM" | "5 PM" → minutes, or null
    if (s == null || s === '') return null;
    var m = String(s).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\.?$/i);
    if (!m) return null;
    var h = parseInt(m[1], 10), mi = parseInt(m[2] || '0', 10), ap = (m[3] || '').toLowerCase();
    if (ap === 'p' && h < 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }
  function trimNum(n) { return String(cents(n)).replace(/\.0+$/, ''); }

  function zoneFor(miles, cfg) {
    cfg = withDefaults(cfg);
    if (miles == null || miles === '' || !isFinite(Number(miles))) return null;
    var m = Number(miles);
    for (var i = 0; i < cfg.zones.length; i++) {
      var z = cfg.zones[i];
      if (z.max_mi == null || m < z.max_mi) return z;
    }
    return cfg.zones[cfg.zones.length - 1];
  }

  function materialById(id, cfg) {
    var list = cfg.install.materials;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function levelRate(level, cfg) {
    var l = cfg.install.levels;
    for (var i = 0; i < l.length; i++) if (Number(l[i].id) === Number(level)) return num(l[i].rate, 0);
    return num(l[0] && l[0].rate, 0);
  }
  function rateForMaterial(id, cfg) {
    var m = materialById(id, cfg);
    return levelRate(m ? m.level : 1, cfg);
  }

  // Weekday business / after hours / Saturday / Sunday, from a date and an
  // arrival window. Returns null when there is no date to judge by.
  function scheduleFor(dateISO, start, end, cfg) {
    cfg = withDefaults(cfg);
    if (!dateISO) return null;
    var p = String(dateISO).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!p) return null;
    var dow = new Date(Date.UTC(+p[1], +p[2] - 1, +p[3])).getUTCDay();
    if (dow === 0) return 'sunday';
    if (dow === 6) return 'saturday';
    var bh = cfg.install.business_hours;
    var open = hm(bh.start), close = hm(bh.end);
    var s = hm(start), e = hm(end);
    if (s != null && open != null && s < open) return 'weekday_after';
    if (s != null && close != null && s >= close) return 'weekday_after';
    if (e != null && close != null && e > close) return 'weekday_after';
    return 'weekday_business';
  }

  function trafficFor(dropTime, cfg) {
    cfg = withDefaults(cfg);
    var t = hm(dropTime);
    if (t == null) return null;
    var d = cfg.delivery;
    for (var i = 0; i < (d.peak_windows || []).length; i++) {
      var w = d.peak_windows[i];
      if (t >= hm(w[0]) && t < hm(w[1])) return 'peak';
    }
    if (t < hm(d.offpeak_before) || t >= hm(d.offpeak_after)) return 'off';
    return 'mid';
  }

  var SCHEDULE_LABEL = {
    weekday_business: 'Weekday, business hours',
    weekday_after: 'Weekday, outside business hours',
    saturday: 'Saturday',
    sunday: 'Sunday'
  };

  // ---------------------------------------------------------------- install
  /**
   * input:
   *   pieces:     [{ name, w_in, h_in, qty, material, sqft_rate?, fixed_fee? }]
   *   distance_mi, address
   *   equipment:  ['h14', ...]
   *   insurance:  'waived' | 'std' | 'extra'     insurance_amount: override for editable options
   *   schedule:   'weekday_business' | 'weekday_after' | 'saturday' | 'sunday'
   *               (or date + arrival_start/arrival_end and it is worked out)
   *   crew, hours: optional manual overrides
   *   height_ft:  optional; above the max means no quote
   *   hourly:     optional override of the installer rate
   */
  function quoteInstall(input, cfgIn) {
    var cfg = withDefaults(cfgIn);
    var C = cfg.install;
    input = input || {};
    var assumptions = [], warnings = [];

    // ---- pieces
    var pieces = (input.pieces || []).filter(function (p) {
      return p && num(p.w_in, 0) > 0 && num(p.h_in, 0) > 0;
    });
    var sqft = 0, sqftChg = 0, fixed = 0, count = 0, maxSide = 0, biggest = 0;
    var unknownMaterial = false, levelsUsed = {};
    var outPieces = pieces.map(function (p) {
      var w = num(p.w_in, 0), h = num(p.h_in, 0), q = Math.max(1, Math.round(num(p.qty, 1)));
      var mat = materialById(p.material, cfg);
      if (!mat) { unknownMaterial = true; mat = materialById(C.default_material, cfg); }
      var rate = (p.sqft_rate !== undefined && p.sqft_rate !== null && p.sqft_rate !== '')
        ? num(p.sqft_rate, 0) : levelRate(mat ? mat.level : 1, cfg);
      var fee = (p.fixed_fee !== undefined && p.fixed_fee !== null && p.fixed_fee !== '')
        ? num(p.fixed_fee, 0) : num(C.fixed_fee, 0);
      var each = (w * h) / 144;
      sqft += each * q;
      sqftChg += each * q * rate;
      fixed += q * fee;
      count += q;
      maxSide = Math.max(maxSide, w, h);
      biggest = Math.max(biggest, each);
      if (mat) levelsUsed[mat.level + ':' + rate] = mat;
      return {
        name: p.name || '', w_in: w, h_in: h, qty: q,
        material: mat ? mat.id : null, material_label: mat ? mat.label : 'Unknown',
        sqft_rate: rate, fixed_fee: fee,
        sqft: cents(each * q), amount: cents(each * q * rate + q * fee)
      };
    });
    if (!outPieces.length) warnings.push('No piece sizes yet — add width × height for each piece.');
    if (unknownMaterial) {
      assumptions.push('Material not stated — assuming Level 1 at ' + money(levelRate(1, cfg)) + '/sq ft');
    } else {
      Object.keys(levelsUsed).forEach(function (k) {
        var m = levelsUsed[k], r = k.split(':')[1];
        var lv = (C.levels.filter(function (l) { return Number(l.id) === Number(m.level); })[0] || {}).label || ('Level ' + m.level);
        assumptions.push(lv + ' ' + m.label.split(' (')[0].toLowerCase() + ' at ' + money(r) + '/sq ft');
      });
    }

    // ---- equipment
    var equipFee = 0, rig = 0, needsTwo = false, equipLines = [], hasCrane = false;
    (input.equipment || []).forEach(function (id) {
      var e = null;
      for (var i = 0; i < C.equipment.length; i++) if (C.equipment[i].id === id) e = C.equipment[i];
      if (!e) return;
      equipFee += num(e.fee, 0);
      rig = Math.max(rig, num(e.rig_hrs, 0));
      needsTwo = needsTwo || !!e.forces_two;
      if (e.crane) hasCrane = true;
      equipLines.push({ label: e.label, amount: cents(num(e.fee, 0)) });
    });
    var height = num(input.height_ft, null);
    var tooHigh = height != null && height > num(C.max_height_ft, 35);
    if (tooHigh) warnings.push('Install height ' + trimNum(height) + ' ft is above ' + C.max_height_ft + ' ft — hand off to a person, Nova does not quote this.');
    if (hasCrane) warnings.push('Crane / lift price is a flat placeholder — cranes usually carry a day or half-day rate. Confirm before sending.');

    // ---- crew
    var byArea = C.crew.max;
    for (var s = 0; s < C.crew.steps.length; s++) {
      if (sqft <= num(C.crew.steps[s].max_sqft, 0)) { byArea = C.crew.steps[s].crew; break; }
    }
    var crew = Math.min(num(C.crew.max, 4), byArea);
    var crewWhy = [];
    if (needsTwo && crew < 2) { crew = 2; crewWhy.push('equipment at height needs a spotter'); }
    if ((maxSide >= num(C.crew.oversize_side_in, 96) || biggest > num(C.crew.oversize_sqft, 30)) && crew < 2) {
      crew = 2; crewWhy.push('oversized piece needs two people');
    }
    if (input.crew != null && input.crew !== '' && num(input.crew, 0) > 0) crew = Math.round(num(input.crew, crew));

    // ---- hours
    var H = C.hours;
    var rawHours = num(H.setup, 0) + num(H.per_piece, 0) * count +
      (crew > 0 ? sqft / (num(H.sqft_per_installer_hour, 100) * crew) : 0) + rig;
    var step = num(H.round_to, 0.5) || 0.5;
    var hours = Math.max(num(H.minimum, 1), Math.round(rawHours / step) * step);
    if (input.hours != null && input.hours !== '' && num(input.hours, 0) > 0) hours = num(input.hours, hours);

    // ---- schedule
    var schedule = input.schedule || scheduleFor(input.date, input.arrival_start, input.arrival_end, cfg);
    if (!schedule) {
      schedule = 'weekday_business';
      assumptions.push('Weekday inside business hours — no surcharge');
    }
    var S = C.surcharge;
    var mult = schedule === 'sunday' ? num(S.sunday_mult, 2)
      : schedule === 'saturday' ? num(S.saturday_mult, 1.5)
      : schedule === 'weekday_after' ? num(S.after_hours_mult, 1.5) : 1;
    var callout = mult > 1 ? num(S.callout_fee, 0) : 0;

    // ---- labor
    var hourly = (input.hourly != null && input.hourly !== '') ? num(input.hourly, C.hourly) : num(C.hourly, 0);
    var labor = crew * hours * hourly * mult;

    // ---- insurance
    var insId = input.insurance || null;
    var ins = null;
    for (var k = 0; k < C.insurance.length; k++) if (C.insurance[k].id === (insId || C.default_insurance)) ins = C.insurance[k];
    if (!ins) ins = C.insurance[0] || { id: 'none', label: 'Insurance', amount: 0 };
    var insAmt = (input.insurance_amount != null && input.insurance_amount !== '') ? num(input.insurance_amount, ins.amount) : num(ins.amount, 0);
    if (!insId) assumptions.push('Standard ' + money(insAmt).replace('.00', '') + ' liability insurance (' + ins.label + ')');

    // ---- travel
    var miles = (input.distance_mi === '' || input.distance_mi == null) ? null : num(input.distance_mi, null);
    if (miles == null) warnings.push('Distance not given — travel is $0 until a driving distance from ' + cfg.origin.split(',')[0] + ' is entered.');
    var travel = (miles || 0) * 2 * num(C.mile_rate, 0);
    var zone = zoneFor(miles, cfg);

    // ---- total
    var materials = sqftChg + fixed;
    var subtotal = labor + materials + travel + equipFee + insAmt + callout;
    var minimum = num(C.minimum, 0);
    var topUp = subtotal < minimum && outPieces.length ? cents(minimum - subtotal) : 0;
    var total = subtotal + topUp;

    if (miles != null && miles > num(C.handoff_miles, 100)) {
      var pct = total > 0 ? Math.round(travel / total * 100) : 0;
      warnings.push('Travel is ' + pct + '% of this job and the crew\'s drive time is not in the number — past ' +
        C.handoff_miles + ' miles quote it as a travel day / per diem. Hand off.');
    }

    // ---- lines, in the order the training doc assembles them
    var lines = [];
    if (materials > 0) lines.push({ key: 'materials',
      label: 'Graphics & materials · ' + count + (count === 1 ? ' piece' : ' pieces') + ', ' + trimNum(sqft) + ' sq ft',
      amount: cents(materials) });
    if (labor > 0) lines.push({ key: 'labor',
      label: 'Labor · ' + crew + (crew === 1 ? ' installer' : ' installers') + ' × ' + trimNum(hours) + (hours === 1 ? ' hr × ' : ' hrs × ') + money(hourly).replace('.00', '') +
        (mult > 1 ? ' × ' + trimNum(mult) : ''),
      amount: cents(labor) });
    equipLines.forEach(function (l) { lines.push({ key: 'equipment', label: l.label, amount: l.amount }); });
    if (insAmt > 0) lines.push({ key: 'insurance', label: 'Insurance · ' + ins.label, amount: cents(insAmt) });
    if (travel > 0) lines.push({ key: 'travel',
      label: 'Travel · ' + trimNum(miles * 2) + ' mi round trip × ' + money(C.mile_rate), amount: cents(travel) });
    if (callout > 0) lines.push({ key: 'callout', label: 'Call-out · ' + SCHEDULE_LABEL[schedule], amount: cents(callout) });
    if (topUp > 0) lines.push({ key: 'minimum', label: 'Minimum charge top-up (' + money(minimum).replace('.00', '') + ' minimum)', amount: topUp });

    return {
      kind: 'installation',
      currency: 'USD',
      inputs: {
        address: input.address || '',
        distance_mi: miles,
        zone: zone ? zone.zone : null,
        date: input.date || '',
        arrival_start: input.arrival_start || '',
        arrival_end: input.arrival_end || '',
        schedule: schedule,
        crew: crew,
        hours: hours,
        equipment: (input.equipment || []).slice(),
        insurance: ins.id,
        insurance_amount: insAmt,
        pieces: outPieces
      },
      breakdown: {
        sqft: cents(sqft), sqft_charge: cents(sqftChg), fixed: cents(fixed), piece_count: count,
        crew: crew, crew_reasons: crewWhy, hours: hours, raw_hours: cents(rawHours), rig_hrs: rig,
        multiplier: mult, labor: cents(labor), equipment: cents(equipFee), insurance: cents(insAmt),
        travel: cents(travel), callout: cents(callout), minimum_topup: topUp
      },
      lines: lines,
      total: tooHigh ? null : cents(total),
      zone: zone,
      assumptions: assumptions,
      warnings: warnings,
      provisional: warnings.length > 0 || tooHigh
    };
  }

  // ---------------------------------------------------------------- delivery
  function quoteDelivery(input, cfgIn) {
    var cfg = withDefaults(cfgIn);
    var D = cfg.delivery;
    input = input || {};
    var assumptions = [], warnings = [];
    var miles = (input.distance_mi === '' || input.distance_mi == null) ? null : num(input.distance_mi, null);
    if (miles == null) warnings.push('Distance not given — enter the driving distance from ' + cfg.origin.split(',')[0] + '.');
    var m = miles || 0;

    var traffic = input.traffic || trafficFor(input.drop_time, cfg);
    if (!traffic) { traffic = D.default_traffic; assumptions.push('No drop time given — assuming midday traffic'); }
    var tr = null;
    for (var i = 0; i < D.traffic.length; i++) if (D.traffic[i].id === traffic) tr = D.traffic[i];
    if (!tr) tr = D.traffic[0];

    var oneWay = (input.minutes_one_way != null && input.minutes_one_way !== '')
      ? Math.round(num(input.minutes_one_way, 0))
      : Math.round((m / num(D.avg_mph, 22)) * 60 * num(tr.factor, 1));
    var mileage = m * num(D.mile_rate, 0);
    var base = num(D.base_fee, 0);
    var timeChg = (oneWay * 2) / 60 * num(D.driver_hourly, 0);
    var total = mileage + base + timeChg;
    var zone = zoneFor(miles, cfg);
    if (zone && zone.zone >= 4) warnings.push(zone.label + ': ' + zone.guidance + '.');
    else if (zone && zone.zone === 3) assumptions.push(zone.label + ' — ' + zone.guidance.toLowerCase());

    var lines = [
      { key: 'mileage', label: 'Mileage · ' + trimNum(m) + ' mi × ' + money(D.mile_rate), amount: cents(mileage) },
      { key: 'base', label: 'Base fee', amount: cents(base) },
      { key: 'time', label: 'Drive time · ' + oneWay + ' min each way × 2 at ' + money(D.driver_hourly).replace('.00', '') + '/hr (' + tr.label.split(' (')[0].toLowerCase() + ')', amount: cents(timeChg) }
    ];
    return {
      kind: 'delivery',
      currency: 'USD',
      inputs: { address: input.address || '', distance_mi: miles, zone: zone ? zone.zone : null,
        traffic: tr.id, drop_time: input.drop_time || '', minutes_one_way: oneWay },
      lines: lines,
      total: cents(total),
      zone: zone,
      assumptions: assumptions,
      warnings: warnings,
      provisional: warnings.length > 0
    };
  }

  // Plain-text version, for the tool result and the card's Copy button.
  function toText(q) {
    var out = [];
    out.push((q.kind === 'delivery' ? 'Local delivery' : 'Installation') + ' estimate' +
      (q.inputs && q.inputs.address ? ' — ' + q.inputs.address : ''));
    q.lines.forEach(function (l) { out.push(l.label + ': ' + money(l.amount)); });
    out.push('Total: ' + (q.total == null ? 'not quoted' : money(q.total)));
    if (q.assumptions.length) out.push('Assumes: ' + q.assumptions.join('; '));
    if (q.warnings.length) out.push('Warnings: ' + q.warnings.join(' | '));
    return out.join('\n');
  }

  return {
    DEFAULTS: DEFAULTS,
    withDefaults: withDefaults,
    quoteInstall: quoteInstall,
    quoteDelivery: quoteDelivery,
    scheduleFor: scheduleFor,
    trafficFor: trafficFor,
    zoneFor: zoneFor,
    rateForMaterial: rateForMaterial,
    SCHEDULE_LABEL: SCHEDULE_LABEL,
    money: money,
    toText: toText
  };
});
