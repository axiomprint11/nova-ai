// Shipping rates and transit times for NovaAI (1.19.142), following the Axiom API hand-off
// "NovaAI Shipping Rates & Draft Quotes": the bot does what the website does — read the product's packing
// rules, work out weight and volume, ask Axiom to split that into boxes, ask the carrier for rates.
//
//   1. packing rules      MySQL product_packings (+ product_packing_options / _items), items' base / mass / thick
//   2. boxes              POST {API}/customers/estimates/calculate-boxes  (only when the product lists packing boxes)
//   3. rates              POST {API}/customers/shipping/find  — once for UPS, once for FedEx, merged
//
// Shipping is quoted, never stored: Axiom re-rates the job at order time. Every rate is a live carrier call, so
// results are cached per product + options + quantity + address for 30 minutes (one conversation's worth).
// The ship-from is always the shop in Glendale, CA 91204 (the API's default when `from` is left out).
'use strict';

module.exports = function makeShipping(deps) {
  const { runQuery, mysql } = deps;
  const log = deps.log || ((...a) => console.log('SHIPPING', ...a));
  const API = String(process.env.AXIOM_API_HOST || 'https://laravelapi.axiomprint.com/api/v1').replace(/\/+$/, '');
  const SHOP = { city: 'Glendale', state: 'CA', zip: '91204' };
  const UPS = { '03': 'Ground', '12': '3 Day Select', '02': '2nd Day Air', '59': '2nd Day Air A.M.', '13': 'Next Day Air Saver', '01': 'Next Day Air', '14': 'Next Day Air Early' };
  const FEDEX = { FEDEX_GROUND: 'Ground', GROUND_HOME_DELIVERY: 'Home Delivery', FEDEX_EXPRESS_SAVER: 'Express Saver', FEDEX_2_DAY: '2 Day', FEDEX_2_DAY_AM: '2 Day AM', STANDARD_OVERNIGHT: 'Standard Overnight', PRIORITY_OVERNIGHT: 'Priority Overnight', FIRST_OVERNIGHT: 'First Overnight' };
  const GROUND = { ups: '03', fedex: 'FEDEX_GROUND' };
  const jarr = (v) => { if (Array.isArray(v)) return v; if (v == null || v === '') return []; try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch (e) { return []; } };
  const num = (v, d) => { const n = Number(v); return isFinite(n) ? n : (d || 0); };
  const r2 = (n) => Math.round(num(n) * 100) / 100;

  // ---------------------------------------------------------------- 1. packing rules
  const packCache = new Map();
  async function packingFor(pid) {
    pid = parseInt(pid); if (!pid) return null;
    const hit = packCache.get(pid); if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.v;
    const packs = await runQuery('SELECT * FROM product_packings WHERE product_id = ' + pid + ' ORDER BY `default` DESC, `order`, id');
    let v = null;
    if (packs && packs.length) {
      const ids = packs.map(p => parseInt(p.id));
      const items = await runQuery('SELECT * FROM product_packing_items WHERE product_packing_id IN (' + ids.join(',') + ')').catch(() => []);
      const options = await runQuery('SELECT * FROM product_packing_options WHERE product_id = ' + pid + ' OR product_packing_id IN (' + ids.join(',') + ')').catch(() => []);
      v = { packs, items: items || [], options: options || [] };
    }
    packCache.set(pid, { at: Date.now(), v });
    return v;
  }
  // The formula tokens, in the order the website replaces them: Quantity · Size$w/h/d · Size$base/mass/thick ·
  // <Variable>$base/mass/thick · <Variable> (the item's value) · floor / round / sqrt; anything else with _ or $ → 0.
  function evalPacking(formula, ctx) {
    if (!formula) return null;
    let s = String(formula);
    s = s.replace(/\b(floor|round|sqrt|ceil|abs|min|max)\s*\(/gi, (m, f) => '__' + f.toLowerCase() + '(');
    s = s.replace(/[A-Za-z_][A-Za-z0-9_]*(\$[A-Za-z]+)?/g, (tok) => { if (/^__/.test(tok)) return tok; const v = ctx[tok]; return v == null || !isFinite(Number(v)) ? '0' : String(Number(v)); });
    s = s.replace(/__(floor|round|sqrt|ceil|abs|min|max)\(/g, 'Math.$1(');
    if (!/^[\d\s+\-*/().,Mathflorundsqceibmx]*$/.test(s)) { log('formula refused', formula); return null; }
    try { const out = Function('"use strict"; return (' + s + ');')(); return isFinite(out) ? r2(out) : null; } catch (e) { log('formula error', formula, e.message); return null; }
  }
  const parseSize = (title) => { const n = String(title || '').match(/(\d+(?:\.\d+)?)/g) || []; return { w: num(n[0]), h: num(n[1]), d: num(n[2]) }; };
  // specs: quoteProduct's `specs` (variable_id, item_id, field, value) — plus quantity, and a custom width / height
  async function packingContext(pid, quantity, specs, extra) {
    extra = extra || {};
    const itemIds = [...new Set((specs || []).map(s => parseInt(s.item_id)).filter(Boolean))];
    const varIds = [...new Set((specs || []).map(s => parseInt(s.variable_id)).filter(Boolean))];
    const items = itemIds.length ? await runQuery('SELECT id, variable_id, title, value, base, mass, thick FROM product_variable_item WHERE id IN (' + itemIds.join(',') + ')') : [];
    const vars = varIds.length ? await runQuery('SELECT id, title, type FROM product_variables WHERE id IN (' + varIds.join(',') + ')') : [];
    const vById = {}; (vars || []).forEach(v => { vById[v.id] = v; });
    const ctx = { Quantity: num(quantity, 1) };
    let size = null;
    for (const it of items || []) {
      const v = vById[it.variable_id]; if (!v) continue;
      const T = String(v.title || '').trim().replace(/\s+/g, '_');
      ctx[T + '$base'] = num(it.base); ctx[T + '$mass'] = num(it.mass); ctx[T + '$thick'] = num(it.thick); ctx[T] = num(it.value);
      if (/^size$/i.test(T)) { size = parseSize(it.title); ctx['Size$base'] = num(it.base); ctx['Size$mass'] = num(it.mass); ctx['Size$thick'] = num(it.thick); }
    }
    // number / text fields carry their value in the spec, not an item
    for (const s of specs || []) { const v = vById[s.variable_id]; if (v && !s.item_id && s.value != null) { const T = String(v.title || '').trim().replace(/\s+/g, '_'); const n = parseFloat(String(s.value).replace(/[^0-9.]/g, '')); if (isFinite(n)) ctx[T] = n; } }
    if (extra.width && extra.height) size = { w: num(extra.width), h: num(extra.height), d: size ? size.d : 0 };   // a custom size typed in
    if (!size) size = { w: 0, h: 0, d: 0 };
    ctx['Size$w'] = size.w; ctx['Size$h'] = size.h; ctx['Size$d'] = size.d;
    return { ctx, size, itemIds };
  }
  // the packing row that applies: a non-default packing whose related items are all selected, else the default;
  // then a packing option whose related_to_values hit the selection replaces the formulas
  function pickPacking(pk, itemIds) {
    if (!pk) return null;
    const has = (id) => itemIds.indexOf(parseInt(id)) > -1;
    let row = pk.packs.find(p => !Number(p.default) && pk.items.filter(i => i.product_packing_id === p.id).length && pk.items.filter(i => i.product_packing_id === p.id).every(i => jarr(i.related_to_item_ids).some(has))) || pk.packs.find(p => Number(p.default)) || pk.packs[0];
    const opt = pk.options.find(o => (!o.product_packing_id || o.product_packing_id === row.id) && jarr(o.related_to_values).length && jarr(o.related_to_values).every(has));
    if (opt) row = Object.assign({}, row, Object.fromEntries(['packing_type', 'packing_boxes', 'packing_weight_formula', 'packing_volume_formula', 'packing_box_length_formula', 'packing_box_width_formula', 'packing_box_height_formula'].filter(k => opt[k] != null && opt[k] !== '').map(k => [k, opt[k]])));
    return row;
  }
  // ---------------------------------------------------------------- 2. boxes
  async function post(path, body) {
    const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) {}
    return { status: r.status, json: j, text };
  }
  async function packagesFor(pid, quantity, specs, extra) {
    const pk = await packingFor(pid);
    const { ctx, size, itemIds } = await packingContext(pid, quantity, specs, extra);
    const row = pickPacking(pk, itemIds);
    const weight = row ? evalPacking(row.packing_weight_formula, ctx) : null;
    const volume = row ? evalPacking(row.packing_volume_formula, ctx) : null;
    const boxes = row ? jarr(row.packing_boxes).map(x => parseInt(x)).filter(Boolean) : [];
    const type = (row && row.packing_type) || 'box';
    const dims = { length: num(size.w) || 1, width: num(size.h) || 1, height: Math.max(num(size.d), 1) };
    const fallbackW = weight && weight > 0 ? weight : 1;
    if (!boxes.length) return { packages: [{ dimensions: dims, weight: fallbackW, quantity: 1 }], weight: fallbackW, volume, type, how: 'one package, product size' };
    const boxDims = type !== 'box' ? { width: evalPacking(row.packing_box_width_formula, ctx) || 0, height: evalPacking(row.packing_box_height_formula, ctx) || 0, length: evalPacking(row.packing_box_length_formula, ctx) || 0 } : { width: 0, height: 0, length: 0 };
    const body = { type, boxesList: boxes, shippingWeight: fallbackW, shippingVolume: volume || 0, quantity: num(quantity, 1), boxDimensions: boxDims };
    const r = await post('/customers/estimates/calculate-boxes', body);
    const rows = r.json && r.json.success !== false && Array.isArray(r.json.data) ? r.json.data : [];
    if (!rows.length) { log('calculate-boxes gave nothing', r.status, r.text.slice(0, 200)); return { packages: [{ dimensions: dims, weight: fallbackW, quantity: 1 }], weight: fallbackW, volume, type, how: 'one package (box split unavailable)' }; }
    const packages = rows.map(x => { const b = x.box || {}; const p = { dimensions: { length: num(b.length) || num(b.width) || 1, width: num(b.width) || 1, height: num(b.height) || 1 }, weight: r2(num(x.boxWeight) || fallbackW), quantity: Math.max(1, parseInt(x.count) || 1) }; if (parseInt(b.id) > 0) p.boxId = parseInt(b.id); return p; });
    return { packages, weight: r2(packages.reduce((n, p) => n + p.weight * p.quantity, 0)), volume, type, how: packages.map(p => p.quantity + ' × ' + p.dimensions.length + '×' + p.dimensions.width + '×' + p.dimensions.height + ' in, ' + p.weight + ' lb each').join('; ') };
  }
  // ---------------------------------------------------------------- 3. rates
  const zipCache = new Map();
  async function cityState(zip) {
    zip = String(zip || '').replace(/\D/g, '').slice(0, 5); if (zip.length !== 5) return null;
    if (zipCache.has(zip)) return zipCache.get(zip);
    let out = null;
    try { const r = await runQuery("SELECT city, state, COUNT(*) AS n FROM address_book WHERE zip LIKE " + mysql.escape(zip + '%') + " AND city <> '' AND state <> '' GROUP BY city, state ORDER BY n DESC LIMIT 1"); if (r && r[0]) out = { city: String(r[0].city).trim(), state: String(r[0].state).trim().toUpperCase().slice(0, 2) }; } catch (e) {}
    zipCache.set(zip, out); return out;
  }
  function nextBusinessDay() { const d = new Date(Date.now() + 86400000); while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); }
  const fmtDate = (ymd) => { const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(ymd || '')); if (!m) return null; const d = new Date(+m[1], +m[2] - 1, +m[3]); return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); };
  function parseRates(carrier, j) {
    const out = { services: [], error: null };
    const data = j && j.data;
    if (!data) { out.error = (j && (j.error || j.message)) || 'No answer from the carrier'; return out; }
    const errs = data.response && data.response.errors; if (Array.isArray(errs) && errs.length) { out.error = errs.map(e => e.message || e.code).join('; '); return out; }
    let list = data.RateResponse && data.RateResponse.RatedShipment; if (list && !Array.isArray(list)) list = [list];
    for (const rs of list || []) {
      const code = String((rs.Service && rs.Service.Code) || '').trim(); const tc = rs.TotalCharges || {}; const gd = rs.GuaranteedDelivery || {};
      const price = tc.MonetaryValueForProduct != null && tc.MonetaryValueForProduct !== '' ? num(tc.MonetaryValueForProduct) : num(tc.MonetaryValue);
      if (!code || !(price > 0)) continue;
      const name = carrier === 'ups' ? (UPS[code] || (rs.Service && rs.Service.Description) || code) : (FEDEX[code] || String(code).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()));
      out.services.push({ carrier: carrier === 'ups' ? 'UPS' : 'FedEx', code, service: name, ground: code === GROUND[carrier], price: r2(price), cost: r2(num(tc.MonetaryValue)),
        business_days: gd.BusinessDaysInTransit != null && gd.BusinessDaysInTransit !== '' ? parseInt(gd.BusinessDaysInTransit) : null, delivery_date: fmtDate(gd.ScheduledDeliveryDate) });
    }
    return out;
  }
  const rateCache = new Map();
  // to: { zip, address?, unit?, city?, state?, country? }; carriers: ['ups','fedex'] (default both)
  async function rates(args) {
    const pid = parseInt(args.product_id) || 0, qty = parseInt(args.quantity) || 0;
    const to = Object.assign({}, args.to || {}); to.zip = String(to.zip || '').replace(/[^0-9-]/g, '').slice(0, 10);
    if (!/^\d{5}/.test(to.zip)) return { ok: false, error: 'A 5-digit US ZIP code is needed to rate shipping.' };
    if (!to.city || !to.state) { const cs = await cityState(to.zip); if (cs) { to.city = to.city || cs.city; to.state = to.state || cs.state; } }
    to.state = String(to.state || '').toUpperCase().slice(0, 2); to.country = String(to.country || 'US').toUpperCase().slice(0, 2);
    to.address = String(to.address || '').slice(0, 35) || (to.city ? '1 Main St' : 'Main St'); to.city = String(to.city || '').slice(0, 35);
    let pack;
    if (pid && args.specs) pack = await packagesFor(pid, qty || 1, args.specs, { width: args.width, height: args.height });
    else pack = { packages: [args.package || { dimensions: { length: 12, width: 9, height: 4 }, weight: 5, quantity: 1 }], weight: 5, volume: null, type: 'box', how: 'a typical 12×9×4 in, 5 lb parcel (no product given)' };
    const key = JSON.stringify([pid, qty, (args.specs || []).map(s => s.item_id || s.value), to.zip, to.address, to.city, to.state, args.carriers || '']);
    const hit = rateCache.get(key); if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.v;
    const carriers = Array.isArray(args.carriers) && args.carriers.length ? args.carriers : ['ups', 'fedex'];
    const body = { shipTo: String(args.ship_to || 'Customer').slice(0, 35), to: { address: to.address, unit: String(to.unit || '').slice(0, 35), city: to.city, state: to.state, postalCode: to.zip, country: to.country },
      numberOfPieces: pack.packages.reduce((n, p) => n + (p.quantity || 1), 0), pickup_date: nextBusinessDay(), saturdayDelivery: 'false', packages: pack.packages };
    if (pid) body.productId = pid;
    const services = [], errors = [];
    for (const c of carriers) {
      try {
        let r = await post('/customers/shipping/find', Object.assign({ carrier: c }, body));
        if (r.status === 429) { await new Promise(x => setTimeout(x, 3000)); r = await post('/customers/shipping/find', Object.assign({ carrier: c }, body)); }
        if (r.status >= 400) { errors.push(c.toUpperCase() + ': HTTP ' + r.status); log(c, 'HTTP', r.status, r.text.slice(0, 300)); continue; }
        const p = parseRates(c, r.json); if (p.error) errors.push(c.toUpperCase() + ': ' + p.error); services.push(...p.services);
      } catch (e) { errors.push(c.toUpperCase() + ': ' + e.message); }
    }
    services.sort((a, b) => a.price - b.price);
    const ground = services.filter(s => s.ground);
    const v = { ok: services.length > 0, ship_from: SHOP.city + ', ' + SHOP.state + ' ' + SHOP.zip, ship_to: [to.city, to.state].filter(Boolean).join(', ') + ' ' + to.zip, packages: pack.packages, weight_lb: pack.weight, packing: pack.how,
      services, ground: ground.map(g => ({ carrier: g.carrier, business_days: g.business_days, delivery_date: g.delivery_date, price: g.price })), errors,
      note: 'Live carrier rates for the shop in Glendale, CA → ' + to.zip + '. Shipping is quoted, not stored: the website re-rates the job at order time. Transit days are business days AFTER the job is ready (ships the next business day).' };
    if (!v.ok && !errors.length) v.error = 'Neither carrier returned a rate for that address — offer pick-up or ask for a full street address.';
    rateCache.set(key, { at: Date.now(), v }); if (rateCache.size > 2000) rateCache.delete(rateCache.keys().next().value);
    return v;
  }
  // "How long does ground take to 10001?" — transit days only, with a typical parcel
  async function transitTo(zip) {
    const r = await rates({ to: { zip }, carriers: ['ups', 'fedex'] });
    return { ok: r.ok, ship_from: r.ship_from, ship_to: r.ship_to, ground: r.ground, errors: r.errors, note: 'UPS / FedEx Ground transit from Glendale to ' + zip + ', in business days after the job ships (it ships the next business day after it is ready). Prices here are for a typical small parcel — rate the actual product for a real price.' };
  }
  return { rates, transitTo, packagesFor, evalPacking, UPS, FEDEX, API };
};
