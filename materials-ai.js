// Material AI (1.20.159) — the materials Axiom buys, described well, with every supplier that sells them.
//
// Three layers, kept apart on purpose:
//   1. the MATERIAL (CRM `materials`, read-only) — what it is. The website's options link to it; the customer never sees a vendor.
//      Nova adds the describing fields the CRM lacks (ma_specs): form (sheet / roll / rigid / item), thickness, color, edge color,
//      adhesive, finish, coating, paper weight, features, weight per unit, and the unit we count it in (the base unit).
//   2. SUPPLIER ITEMS (ma_sources) — how it is bought: vendor (CRM `sellers`), their SKU / invoice wording, the buy unit
//      (carton of 500 sheets 20×28, a 54"×150' roll…), cost per buy unit, and how many BASE units one unit yields
//      (a 20×28 sheet = 2 press sheets of 13×19; a 48×96 board = 32 sq ft) — so two vendors of the same material compare.
//   3. STOCK (ma_stock) — receipts (by hand, or from every invoice line linked to the material) and counts ("what is left?").
//      Nothing takes stock out yet, so on hand = the last count + what came in since; the drop between counts is the usage.
//
// Prices check themselves: every bill line / purchase item BookkeeperAI linked to a material is compared with that vendor's
// supplier item — more than `alert_pct` (10 %) off and an alert is raised (accept the new price, renegotiate, or dismiss) and
// emailed (Notify kind ma.price). Receipts over time give the reorder cycle and a "time to reorder?" flag.
// Nothing is written to the CRM.
'use strict';

module.exports = function mountMaterialsAi(app, deps) {
  const { db, auth, adminOnly, serveVersionedHtml, runQuery, sendMail, Notify, isBookkeeper } = deps;
  const dbAll = (sql, p) => new Promise((res, rej) => db.all(sql, p || [], (e, r) => e ? rej(e) : res(r || [])));
  const dbGet = (sql, p) => new Promise((res, rej) => db.get(sql, p || [], (e, r) => e ? rej(e) : res(r)));
  const dbRun = (sql, p) => new Promise((res, rej) => db.run(sql, p || [], function (e) { e ? rej(e) : res(this); }));
  const userId = (req) => String((req.user && (req.user.key || req.user.username)) || 'unknown').replace(/^(member|user):/, '');
  const errlog = (w, m) => console.error('[material-ai] ' + w + ': ' + m);
  const num = (v) => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[$,\s]/g, '')); return isFinite(n) ? n : null; };
  const str = (v, n) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, n || 200) : null; };

  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS ma_specs (material_id INTEGER PRIMARY KEY, form TEXT, thickness REAL, thickness_unit TEXT, color TEXT, edge_color TEXT,
      adhesive TEXT, finish TEXT, coated TEXT, basis_weight REAL, basis_unit TEXT, sides TEXT, use_where TEXT, features TEXT, brand TEXT, product_line TEXT,
      base_unit TEXT, press_w REAL, press_h REAL, weight REAL, weight_unit TEXT, weight_per TEXT, notes TEXT, updated_by TEXT, updated_at TEXT)`);
    /* 1.20.161: the Sheet / Roll forms — colour swatch, back finish, roll liner, the machines that print it, our SKU, a measured stack */
    ['color_hex TEXT', 'finish_back TEXT', 'liner TEXT', 'machines TEXT', 'sku TEXT', 'stack_thick REAL', 'stack_n INTEGER', 'geo_key TEXT', 'substrate TEXT'].forEach(c => db.run('ALTER TABLE ma_specs ADD COLUMN ' + c, () => {}));
    db.run(`CREATE TABLE IF NOT EXISTS ma_sources (id INTEGER PRIMARY KEY AUTOINCREMENT, material_id INTEGER, seller_id INTEGER, vendor_name TEXT, vendor_sku TEXT,
      vendor_desc TEXT, buy_unit TEXT DEFAULT 'sheet', units_per_buy REAL DEFAULT 1, unit_w REAL, unit_h REAL, yield_override REAL, cost_per_buy REAL,
      cost_date TEXT, cost_from TEXT, preferred INTEGER DEFAULT 0, active INTEGER DEFAULT 1, lead_days INTEGER, min_order TEXT, match_how TEXT, notes TEXT,
      last_price REAL, last_price_per TEXT, last_price_at TEXT, last_ref TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT)`);
    db.run('CREATE INDEX IF NOT EXISTS ma_sources_m ON ma_sources(material_id)');
    /* confirmed = a person saved this supplier item (pack, size, cost); seeded / invoice-made ones are not, so an invoice never
       guesses a carton as one sheet into stock */
    db.run('ALTER TABLE ma_sources ADD COLUMN confirmed INTEGER DEFAULT 0', () => {});
    db.run(`CREATE TABLE IF NOT EXISTS ma_prices (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER, material_id INTEGER, at TEXT, price REAL, per TEXT,
      unit_cost REAL, qty REAL, ref_kind TEXT, ref_id INTEGER, ref_idx INTEGER, line_text TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    db.run('CREATE INDEX IF NOT EXISTS ma_prices_s ON ma_prices(source_id)');
    db.run(`CREATE TABLE IF NOT EXISTS ma_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER, material_id INTEGER, ref_kind TEXT, ref_id INTEGER, ref_idx INTEGER,
      at TEXT, line_text TEXT, per TEXT, expected REAL, found REAL, pct REAL, status TEXT DEFAULT 'open', note TEXT, decided_by TEXT, decided_at TEXT,
      mailed_at TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    db.run(`CREATE TABLE IF NOT EXISTS ma_unmatched (id INTEGER PRIMARY KEY AUTOINCREMENT, material_id INTEGER, seller_id INTEGER, vendor_name TEXT, ref_kind TEXT,
      ref_id INTEGER, ref_idx INTEGER, at TEXT, line_text TEXT, qty REAL, price REAL, status TEXT DEFAULT 'open', created_at TEXT DEFAULT (datetime('now')))`);
    db.run(`CREATE TABLE IF NOT EXISTS ma_stock (id INTEGER PRIMARY KEY AUTOINCREMENT, material_id INTEGER, kind TEXT, qty REAL, source_id INTEGER, buy_qty REAL,
      location TEXT, note TEXT, ref_kind TEXT, ref_id INTEGER, ref_idx INTEGER, by TEXT, at TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    db.run('CREATE INDEX IF NOT EXISTS ma_stock_m ON ma_stock(material_id)');
    db.run('CREATE TABLE IF NOT EXISTS ma_seen (ref_kind TEXT, ref_id INTEGER, ref_idx INTEGER, at TEXT, PRIMARY KEY (ref_kind, ref_id, ref_idx))');
    db.run('CREATE TABLE IF NOT EXISTS ma_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
    /* 1.20.161 — Geo types kept in Nova: an edit of a CRM type / sub type (crm_id set) or one added here (crm_id NULL). The CRM's list is never written. */
    db.run(`CREATE TABLE IF NOT EXISTS ma_geo (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, crm_id INTEGER, parent TEXT, name TEXT, abbr TEXT, icon_url TEXT,
      hidden INTEGER DEFAULT 0, sort INTEGER, updated_by TEXT, updated_at TEXT)`);
  });
  const meta = async (k) => { const r = await dbGet('SELECT value FROM ma_meta WHERE key = ?', [k]); return r ? r.value : null; };
  const setMeta = (k, v) => dbRun("INSERT INTO ma_meta (key, value, updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [k, String(v)]);
  const DEFAULTS = { alert_pct: 10, invoice_receives: 1, alert_to: process.env.MATERIAL_ALERT_TO || 'gary@axiomprint.com', reorder_days: 7 };
  async function settings() { let s = {}; try { s = JSON.parse((await meta('settings')) || '{}'); } catch (e) {} return Object.assign({}, DEFAULTS, s); }
  if (Notify && Notify.register) Notify.register('ma.price', async () => (await settings()).alert_to);

  // ---- who may open it: admins and bookkeepers
  function guardFn(req, res, next) {
    if (isBookkeeper && isBookkeeper(req)) return next();
    return adminOnly(req, res, next);
  }
  const guard = [auth, guardFn];

  // ---- the vocabulary (the page draws its pickers from this, so one list feeds both)
  const VOCAB = {
    form: [['sheet', 'Sheet'], ['roll', 'Roll'], ['wide_roll', 'Wide roll'], ['rigid', 'Rigid board'], ['item', 'Item / hardware'], ['liquid', 'Ink / liquid']],
    substrate_sheet: [['paper_text', 'Paper Text'], ['cardstock', 'Paper Cardstock'], ['plastic', 'Plastic'], ['clear', 'Clear'], ['magnetic', 'Magnetic']],
    substrate_roll: [['bopp', 'BOPP'], ['clear', 'Clear'], ['holographic', 'Holographic'], ['silver', 'Silver'], ['lamination', 'Lamination']],
    thickness_unit: [['in', 'in'], ['mm', 'mm'], ['mil', 'mil'], ['pt', 'pt']],
    thickness_unit_sr: [['pt', 'pt'], ['mil', 'mil'], ['gsm', 'gsm']],
    adhesive_roll: [['none', 'No adhesive'], ['permanent', 'Permanent'], ['removable', 'Removable'], ['static', 'Static']],
    liner: [['none', 'No liner'], ['paper40', 'Paper 40#'], ['clear40', 'Clear 40#'], ['paper70', 'Paper 70#']],
    weight_per: [['base', 'Per unit'], ['sqft', 'Per sq ft'], ['crm100', 'Per 100 sheets of 8.5×11'], ['p100_1319', 'Per 100 sheets of 13×19']],
    stack_n: [['1', '1 piece'], ['10', '10 pieces'], ['100', '100 pieces']],
    adhesive: [['none', 'No adhesive'], ['permanent', 'Permanent'], ['removable', 'Removable'], ['repositionable', 'Repositionable'], ['static', 'Static cling']],
    finish: [['gloss', 'Gloss'], ['matte', 'Matte'], ['satin', 'Satin / Silk'], ['uncoated', 'Uncoated'], ['textured', 'Textured / Linen'], ['metallic', 'Metallic'], ['clear', 'Clear'], ['frosted', 'Frosted']],
    coated: [['none', 'Not coated'], ['c1s', 'Coated 1 side (C1S)'], ['c2s', 'Coated 2 sides (C2S)']],
    basis_unit: [['text', '# Text'], ['cover', '# Cover'], ['bond', '# Bond'], ['index', '# Index'], ['gsm', 'gsm'], ['oz', 'oz (banner)']],
    sides: [['1', 'Front only'], ['2', '2 sides'], ['0', 'None']],
    use_where: [['indoor', 'Indoor'], ['outdoor', 'Outdoor'], ['both', 'Indoor & outdoor']],
    features: ['Waterproof', 'Tear-resistant', 'UV-resistant', 'Scratch-resistant', 'Food-safe', 'Fire-rated', 'Recyclable', 'Blockout / opaque', 'Translucent', 'Reflective', 'Magnetic', 'Laser-safe', 'Eco / FSC'],
    base_unit: [['sheet', 'Sheet'], ['each', 'Unit'], ['msi', 'MSI (1,000 sq in)'], ['sqft', 'Sq ft'], ['lft', 'Linear ft'], ['roll', 'Roll'], ['press', 'Press sheet (a set size)']],
    buy_unit: [['sheet', 'Sheet'], ['carton', 'Carton'], ['ream', 'Ream'], ['box', 'Box'], ['skid', 'Skid'], ['roll', 'Roll'], ['pack', 'Pack'], ['each', 'Each']],
    weight_unit: [['lb', 'lb'], ['kg', 'kg'], ['oz', 'oz'], ['g', 'gram']]
  };
  const RIGID = ['acrylic', 'pvc', 'foam', 'coroplast', 'aluminnum', 'wood', 'cardboard'];

  // ---- CRM reads (cached)
  const cache = {};
  async function cached(key, ms, fn, fresh) {
    const c = cache[key]; if (!fresh && c && Date.now() - c.at < ms) return c.v;
    const v = await fn(); cache[key] = { v, at: Date.now() }; return v;
  }
  const crmMaterials = (fresh) => cached('materials', 5 * 60e3, async () => {
    const rows = await runQuery('SELECT m.id, m.name, m.material, m.type, m.production_step, m.thickness, m.t_measure, m.size, m.size_w, m.size_h, m.weight, m.color_name, m.color_hex, ' +
      'm.w_measure, m.photo_url, m.website_image_url, m.swatch_name, m.supplier, m.seller_id, m.manufacturer, m.stock, m.location, m.code, m.cost, m.department_ids, m.geo_type_id, m.geo_sub_type_id, ' +
      'gt.name AS geo_type, gs.name AS geo_sub_type FROM materials m LEFT JOIN geo_type gt ON gt.id = m.geo_type_id LEFT JOIN geo_sub_type gs ON gs.id = m.geo_sub_type_id ORDER BY m.name');
    let teams = {}; try { (await runQuery('SELECT id, name FROM team')).forEach(t => { teams[t.id] = t.name; }); } catch (e) {}
    rows.forEach(r => { let d = r.department_ids; try { if (typeof d === 'string') d = JSON.parse(d); } catch (e) { d = []; } r.departments = (Array.isArray(d) ? d : []).map(i => teams[i]).filter(Boolean); delete r.department_ids; });
    return rows;
  }, fresh);
  const crmSellers = (fresh) => cached('sellers', 10 * 60e3, async () => {
    const rows = await runQuery('SELECT id, type, company_name, contact_name, email, phone, photo_url, specialty FROM sellers ORDER BY company_name');
    return rows.filter(r => String(r.company_name || '').trim()).map(r => Object.assign(r, sellerKeys(r.company_name)));
  }, fresh);
  const crmUsage = (fresh) => cached('usage', 10 * 60e3, async () => {
    const rows = await runQuery('SELECT pvi.material_id, COUNT(*) AS n, COUNT(DISTINCT pv.product_id) AS products FROM product_variable_item pvi ' +
      'JOIN product_variables pv ON pv.id = pvi.variable_id WHERE pvi.material_id > 0 GROUP BY pvi.material_id');
    const out = {}; rows.forEach(r => { out[r.material_id] = { options: Number(r.n), products: Number(r.products) }; }); return out;
  }, fresh);

  // ---- Geo types: the CRM's list with Nova's edits on top (keys ct<id> / cs<id> = CRM, nt<id> / ns<id> = made in Nova)
  const crmGeo = (fresh) => cached('geo', 10 * 60e3, async () => ({
    types: await runQuery('SELECT id, name FROM geo_type ORDER BY name'),
    subs: await runQuery('SELECT id, geo_type_id, name, abbreviation, icon_url FROM geo_sub_type ORDER BY name')
  }), fresh);
  async function geoTree(fresh) {
    const g = await crmGeo(fresh), ov = await dbAll('SELECT * FROM ma_geo ORDER BY id');
    const ovOf = (kind, cid) => ov.find(o => o.kind === kind && o.crm_id === cid) || null;
    const types = [], byKey = {};
    g.types.forEach(t => { const o = ovOf('type', t.id); types.push({ key: 'ct' + t.id, crm: true, crm_name: t.name, name: (o && o.name) || t.name, edited: !!(o && o.name && o.name !== t.name), hidden: !!(o && o.hidden), subs: [] }); });
    ov.filter(o => o.kind === 'type' && !o.crm_id).forEach(o => types.push({ key: 'nt' + o.id, crm: false, name: o.name, hidden: !!o.hidden, subs: [] }));
    types.forEach(t => { byKey[t.key] = { key: t.key, name: t.name, type_key: t.key, type_name: t.name, hidden: t.hidden }; });
    const subs = [];
    g.subs.forEach(x => { const o = ovOf('sub', x.id); subs.push({ key: 'cs' + x.id, crm: true, parent: (o && o.parent) || 'ct' + x.geo_type_id, crm_name: x.name, name: (o && o.name) || x.name,
      abbr: o && o.abbr != null ? o.abbr : (x.abbreviation || ''), crm_abbr: x.abbreviation || '', icon: (o && o.icon_url) || x.icon_url || null,
      edited: !!(o && ((o.name && o.name !== x.name) || (o.abbr != null && o.abbr !== (x.abbreviation || '')))), hidden: !!(o && o.hidden) }); });
    ov.filter(o => o.kind === 'sub' && !o.crm_id).forEach(o => subs.push({ key: 'ns' + o.id, crm: false, parent: o.parent, name: o.name, abbr: o.abbr || '', icon: o.icon_url || null, hidden: !!o.hidden }));
    subs.forEach(x => { const t = types.find(y => y.key === x.parent); if (!t) return; t.subs.push(x); byKey[x.key] = { key: x.key, name: x.name, abbr: x.abbr, type_key: t.key, type_name: t.name, hidden: x.hidden || t.hidden }; });
    types.sort((a, b) => a.name.localeCompare(b.name)); types.forEach(t => t.subs.sort((a, b) => a.name.localeCompare(b.name)));
    return { types, byKey };
  }

  // ---- matching a free-text supplier ("Kelly", "Montroy Sign", "GWF") to a CRM seller
  const STOP = ['inc', 'co', 'llc', 'corp', 'company', 'the', 'and', 'of', 'dba'];
  const COMMON = ['paper', 'sign', 'supply', 'supplies', 'china', 'us', 'usa', 'the', 'print', 'printing', 'label', 'graphics'];
  const norm = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  function sellerKeys(name) {
    const n = norm(name), words = n.split(' ').filter(w => w && STOP.indexOf(w) === -1);
    return { _n: n, _c: n.replace(/ /g, ''), _w: words, _ini: words.map(w => w[0]).join('') };
  }
  function lev(a, b) {
    const m = a.length, n = b.length; if (Math.abs(m - n) > 2) return 9; const d = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  }
  function matchSeller(text, sellers) {
    const k = sellerKeys(text); if (!k._n) return null;
    const pick = (list, how) => {
      if (!list.length) return null;
      const names = Array.from(new Set(list.map(s => s._n))); if (names.length > 1) return null;
      return { seller: list.find(s => s.type === 'supplier') || list[0], how };
    };
    let r = pick(sellers.filter(s => s._n === k._n || s._c === k._c), 'name'); if (r) return r;
    if (k._c.length >= 5) { r = pick(sellers.filter(s => s._c.length >= 5 && (s._c.indexOf(k._c) === 0 || k._c.indexOf(s._c) === 0)), 'name'); if (r) return r; }
    if (k._c.length >= 2 && k._c.length <= 4 && k._w.length === 1) { r = pick(sellers.filter(s => s._ini === k._c && s._w.length >= 2), 'initials'); if (r) return r; }
    const fw = k._w[0];
    if (fw && fw.length >= 3 && COMMON.indexOf(fw) === -1) {
      r = pick(sellers.filter(s => s._w.indexOf(fw) > -1), 'first word'); if (r) return r;
      if (fw.length >= 6) { r = pick(sellers.filter(s => s._w[0] && s._w[0].length >= 6 && lev(s._w[0], fw) <= 2), 'spelling'); if (r) return r; }
    }
    return null;
  }

  // ---- defaults read from the CRM row, so a material is already partly described before anyone types
  function defaultsFor(m) {
    const type = String(m.type || ''), mat = String(m.material || ''), name = String(m.name || '');
    /* a roll on the Wide Format geo type is a wide roll (vinyl, banner, film for the large-format printers) */
    const form = /role|roll/.test(type) ? (/wide/i.test(String(m.geo_type || '')) ? 'wide_roll' : 'roll') : type === 'sheet' ? (RIGID.indexOf(mat) > -1 ? 'rigid' : 'sheet') : type ? 'item' : null;
    let adhesive = null;
    if (/removable/i.test(name)) adhesive = 'removable'; else if (/permanent/i.test(name)) adhesive = 'permanent'; else if (/cling/i.test(name)) adhesive = 'static';
    else if (/adhesive|bopp_label/.test(mat)) adhesive = 'permanent'; else if (form === 'rigid') adhesive = 'none';
    else if (/paper|cardboard/.test(mat) && !/label|sticker|adhesive|vinyl/i.test(name)) adhesive = 'none';
    let finish = null; if (/\bgloss/i.test(name)) finish = 'gloss'; else if (/\bmatte/i.test(name)) finish = 'matte'; else if (/\bsatin|silk/i.test(name)) finish = 'satin'; else if (/uncoated/i.test(name)) finish = 'uncoated'; else if (/clear/i.test(name) && form === 'rigid') finish = 'clear';
    let basis = null, bu = null; const bw = name.match(/(\d{2,3})\s*#\s*(text|cover|bond|index)?/i); if (bw) { basis = Number(bw[1]); bu = (bw[2] || (/cover|card/i.test(name) ? 'cover' : 'text')).toLowerCase(); }
    const gsm = name.match(/(\d{2,3})\s*gsm/i); if (gsm) { basis = Number(gsm[1]); bu = 'gsm'; }
    /* the CRM keeps thickness in inches when t_measure = 1 and in hundredths of an inch when t_measure = 100 (14PT = 1.431 → 0.0143 in) */
    const thick = Number(m.thickness) > 0 && Number(m.t_measure) === 1 ? Number(m.thickness) : Number(m.thickness) > 0 && Number(m.t_measure) === 100 ? +(Number(m.thickness) / 100).toFixed(5) : null;
    /* paper sheets carry a weight in lb per 100 sheets of 8.5×11 (100# cover = 3.51) — a ready-made weight */
    const paperW = type === 'sheet' && /paper/.test(mat) && Number(m.weight) > 0 && (!m.w_measure || m.w_measure === '100_sh_8.5x11') ? Number(m.weight) : null;
    const mil = name.match(/(\d+(?:\.\d+)?)\s*mil/i), pt = name.match(/(\d+(?:\.\d+)?)\s*pt\b/i);
    /* Sheet / Roll speak in thousandths (PT for paper, Mil for film) or GSM — never inches */
    let tv = thick != null ? thick : (mil ? Number(mil[1]) : null), tu = thick != null ? 'in' : (mil ? 'mil' : null);
    const sr = form === 'sheet' || form === 'roll' || form === 'wide_roll';
    if (sr) {
      if (mil) { tv = Number(mil[1]); tu = 'mil'; }
      else if (pt) { tv = Number(pt[1]); tu = 'pt'; }
      else if (thick != null) { tv = +(thick * 1000).toFixed(2); tu = form === 'sheet' ? 'pt' : 'mil'; }
      else if (gsm) { tv = Number(gsm[1]); tu = 'gsm'; }
    }
    const hex = /^#?[0-9a-f]{6}$/i.test(String(m.color_hex || '').trim()) ? '#' + String(m.color_hex).trim().replace('#', '').toLowerCase() : null;
    return {
      form, adhesive: form === 'sheet' ? null : adhesive, finish, color: m.color_name || null, color_hex: hex, basis_weight: basis, basis_unit: bu, brand: m.manufacturer || null,
      sku: m.code || null, thickness: tv, thickness_unit: tu,
      geo_key: Number(m.geo_sub_type_id) > 0 ? 'cs' + m.geo_sub_type_id : Number(m.geo_type_id) > 0 ? 'ct' + m.geo_type_id : null,
      substrate: substrateOf(form, mat, name),
      base_unit: form === 'roll' || form === 'wide_roll' || form === 'rigid' ? 'sqft' : form === 'sheet' ? 'sheet' : form ? 'each' : null,
      edge_color: form === 'rigid' ? (/clear/i.test(name) ? 'Clear' : m.color_name || null) : null,
      weight: paperW, weight_unit: paperW ? 'lb' : null, weight_per: paperW ? 'crm100' : null,
      coated: /coated 2 side|c2s/i.test(name) ? 'c2s' : /coated 1 side|c1s/i.test(name) ? 'c1s' : /uncoated/i.test(name) ? 'none' : null
    };
  }
  /* the Material pick of a Sheet / Roll, read from the CRM's material kind and the name */
  function substrateOf(form, mat, name) {
    if (form === 'sheet') {
      if (/magnet/.test(mat) || /magnet/i.test(name)) return 'magnetic';
      if (/clear|transparent/i.test(name)) return 'clear';
      if (mat === 'plastic' || /plastic|synthetic|polyester/i.test(name)) return 'plastic';
      if (mat === 'paper_cover' || /cover|cardstock|card stock/i.test(name)) return 'cardstock';
      if (mat === 'paper_text' || /text|bond/i.test(name)) return 'paper_text';
      return null;
    }
    if (form === 'roll' || form === 'wide_roll') {
      if (mat === 'lamination' || /lamina/i.test(name)) return 'lamination';
      if (/holo/i.test(name)) return 'holographic';
      if (/silver|chrome|metallic/i.test(name)) return 'silver';
      if (/clear|transparent/i.test(name)) return 'clear';
      if (/bopp/i.test(mat + ' ' + name)) return 'bopp';
    }
    return null;
  }
  const SPEC_FIELDS = ['form', 'thickness', 'thickness_unit', 'color', 'color_hex', 'edge_color', 'adhesive', 'liner', 'finish', 'finish_back', 'coated', 'basis_weight', 'basis_unit',
    'sides', 'machines', 'use_where', 'features', 'brand', 'product_line', 'sku', 'base_unit', 'press_w', 'press_h', 'weight', 'weight_unit', 'weight_per', 'stack_thick', 'stack_n', 'geo_key', 'substrate', 'notes'];
  const NUM_SPEC = ['thickness', 'basis_weight', 'press_w', 'press_h', 'weight', 'stack_thick', 'stack_n'];
  /* fields a form does not have — never shown, never counted (rigid / item / ink keep the full set until they get their own form) */
  const NOT_ON = { sheet: ['edge_color', 'adhesive', 'liner', 'use_where', 'coated', 'product_line'],
    roll: ['edge_color', 'use_where', 'coated', 'product_line', 'finish_back'], wide_roll: ['edge_color', 'use_where', 'coated', 'product_line', 'finish_back'] };
  const SR = (f) => f === 'sheet' || f === 'roll' || f === 'wide_roll';
  function mergedSpec(m, saved) {
    const d = defaultsFor(m), out = {}, from = {};
    SPEC_FIELDS.forEach(f => { const v = saved ? saved[f] : null; if (v != null && v !== '') { out[f] = v; from[f] = 'nova'; } else if (d[f] != null && d[f] !== '') { out[f] = d[f]; from[f] = 'crm'; } else out[f] = null; });
    out.features = out.features ? String(out.features).split(',').map(s => s.trim()).filter(Boolean) : [];
    out.machines = out.machines ? String(out.machines).split(',').map(Number).filter(n => n > 0) : [];
    (NOT_ON[out.form] || []).forEach(f => { out[f] = null; delete from[f]; });
    /* an older Sheet / Roll thickness in inches or mm reads as PT / Mil */
    if (out.substrate && !(VOCAB[out.form === 'sheet' ? 'substrate_sheet' : 'substrate_roll'] || []).some(p => p[0] === out.substrate) && from.substrate === 'crm') out.substrate = null;
    if (!SR(out.form)) { out.substrate = null; delete from.substrate; }
    if (SR(out.form) && Number(out.thickness) > 0 && (out.thickness_unit === 'in' || out.thickness_unit === 'mm' || !out.thickness_unit)) {
      const i = out.thickness_unit === 'mm' ? Number(out.thickness) / 25.4 : Number(out.thickness);
      out.thickness = +(i * 1000).toFixed(2); out.thickness_unit = out.form === 'sheet' ? 'pt' : 'mil';
    }
    return { spec: out, from };
  }

  // ---- units: a supplier item's yield in base units, and the cost per base unit
  function inches(v, u) { const n = Number(v); if (!(n > 0) || u === 'gsm') return null; return u === 'mm' ? n / 25.4 : u === 'mil' ? n / 1000 : u === 'pt' ? n / 1000 : n; }
  function yieldOf(src, spec) {
    if (Number(src.yield_override) > 0) return Number(src.yield_override);
    const w = Number(src.unit_w) || 0, h = Number(src.unit_h) || 0, b = spec.base_unit || 'sheet';
    if (b === 'sqft') return w > 0 && h > 0 ? +(w * h / 144).toFixed(4) : null;
    if (b === 'msi') return w > 0 && h > 0 ? +(w * h / 1000).toFixed(4) : null;
    if (b === 'lft') return h > 0 ? +(h / 12).toFixed(4) : null;
    if (b === 'press') {
      const pw = Number(spec.press_w) || 0, ph = Number(spec.press_h) || 0; if (!(pw > 0 && ph > 0 && w > 0 && h > 0)) return null;
      return Math.max(Math.floor(w / pw) * Math.floor(h / ph), Math.floor(w / ph) * Math.floor(h / pw)) || null;
    }
    return 1;
  }
  const BASE_LABEL = { sheet: 'sheet', press: 'press sheet', sqft: 'sq ft', msi: 'MSI', lft: 'linear ft', roll: 'roll', each: 'unit' };
  function baseLabel(spec) { return spec.base_unit === 'press' && spec.press_w && spec.press_h ? 'press sheet ' + spec.press_w + '×' + spec.press_h : BASE_LABEL[spec.base_unit || 'sheet'] || 'unit'; }
  function shapeSource(s, spec) {
    const per = Number(s.units_per_buy) > 0 ? Number(s.units_per_buy) : 1, y = yieldOf(s, spec);
    const cpb = s.cost_per_buy != null ? Number(s.cost_per_buy) : null, cpu = cpb != null ? cpb / per : null;
    return Object.assign({}, s, { units_per_buy: per, yield: y, cost_per_unit: cpu != null ? +cpu.toFixed(4) : null,
      cost_per_base: cpu != null && y ? +(cpu / y).toFixed(4) : null, base_per_buy: y ? +(y * per).toFixed(3) : null });
  }

  // ---- weight & cube: what one base unit weighs and how much space it takes (shipping)
  const OZ = { oz: 1, lb: 16, g: 1 / 28.3495, kg: 1000 / 28.3495 };
  function physics(spec, srcs) {
    const std = srcs.find(s => s.preferred && s.unit_w && s.unit_h) || srcs.find(s => s.unit_w && s.unit_h) || null;
    /* a measured stack (1.657 in for 100 pieces) beats the nominal thickness for the volume */
    const stack = Number(spec.stack_thick) > 0 && Number(spec.stack_n) > 0 ? Number(spec.stack_thick) / Number(spec.stack_n) : null;
    const thick = stack || inches(spec.thickness, spec.thickness_unit);
    let area = null;   /* square inches of one base unit */
    if (spec.base_unit === 'sqft') area = 144; else if (spec.base_unit === 'msi') area = 1000; else if (spec.base_unit === 'press' && spec.press_w && spec.press_h) area = spec.press_w * spec.press_h;
    else if (spec.base_unit === 'lft' && std) area = std.unit_w * 12; else if (std && (spec.base_unit === 'sheet' || spec.base_unit === 'roll')) area = std.unit_w * std.unit_h;
    let oz = null, how = null;
    if (Number(spec.weight) > 0 && spec.weight_unit) {
      const w = Number(spec.weight) * (OZ[spec.weight_unit] || 1);
      const per = spec.weight_per || 'base';   /* base · sqft · msi (1,000 sq in) */
      if (per === 'base') { oz = w; how = 'entered'; }
      else if (per === 'sqft' && area) { oz = w * area / 144; how = 'from weight per sq ft'; }
      else if (per === 'crm100' && area) { oz = w * area / 9350; how = 'from the weight per 100 sheets 8.5×11'; }
      else if (per === 'p100_1319' && area) { oz = w * area / 24700; how = 'from the weight per 100 sheets 13×19'; }
    } else if (spec.thickness_unit === 'gsm' && Number(spec.thickness) > 0 && area) {
      oz = Number(spec.thickness) * (area * 0.00064516) / 28.3495; how = 'from ' + spec.thickness + ' gsm';
    } else if (Number(spec.basis_weight) > 0 && area) {
      /* paper: basis weight is for 500 sheets of the basic size (text 25×38, cover 20×26, bond 17×22, index 25.5×30.5); gsm is grams per m² */
      const BASIC = { text: 950, cover: 520, bond: 374, index: 777.75 };
      if (spec.basis_unit === 'gsm') { oz = Number(spec.basis_weight) * (area * 0.00064516) / 28.3495; how = 'from gsm'; }
      else if (BASIC[spec.basis_unit]) { oz = Number(spec.basis_weight) * 16 * (area / BASIC[spec.basis_unit]) / 500; how = 'from # ' + spec.basis_unit; }
      else if (spec.basis_unit === 'oz') { oz = Number(spec.basis_weight) * area / 1296; how = 'from oz per sq yd'; }
    } else if (thick && area && /acrylic/i.test(String(spec._material || ''))) { oz = thick * area * 16.387 * 1.19 / 28.3495; how = 'acrylic density 1.19'; }
    const cube = thick && area ? +(thick * area).toFixed(3) : null;
    return { per_unit_oz: oz != null ? +oz.toFixed(4) : null, weight_how: how, cube_in3: cube, area_in2: area, thickness_in: thick, thick_how: stack ? 'measured stack' : thick ? 'thickness' : null };
  }

  // ---- stock and the reorder cycle
  function stockSummary(rows, srcs) {
    rows = rows.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id - b.id);
    let on = null, lastCount = null, lastIn = null, used = 0, usedFrom = null, usedTo = null, running = [];
    for (const r of rows) {
      const q = Number(r.qty) || 0;
      if (r.kind === 'count') {
        if (on != null && lastCount) { const u = on - q; if (u > 0) { used += u; usedFrom = usedFrom || lastCount.at; usedTo = r.at; } r._used = +(on - q).toFixed(3); }
        on = q; lastCount = r;
      } else if (r.kind === 'receive') { on = (on || 0) + q; lastIn = r; }
      else if (r.kind === 'adjust') on = (on || 0) + q;
      r._after = on != null ? +on.toFixed(3) : null; running.push(r);
    }
    const ins = rows.filter(r => r.kind === 'receive');
    const days = (a, b) => Math.round((new Date(String(b).replace(' ', 'T')) - new Date(String(a).replace(' ', 'T'))) / 864e5);
    const gaps = []; for (let i = 1; i < ins.length; i++) { const g = days(ins[i - 1].at, ins[i].at); if (g >= 1) gaps.push(g); }
    gaps.sort((a, b) => a - b);
    const cycle = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
    const avgIn = ins.length ? +(ins.reduce((s, r) => s + (Number(r.qty) || 0), 0) / ins.length).toFixed(2) : null;
    const span = usedFrom && usedTo ? Math.max(1, days(usedFrom, usedTo)) : null;
    const perDay = span && used > 0 ? used / span : null;
    const next = lastIn && cycle ? new Date(new Date(String(lastIn.at).replace(' ', 'T')).getTime() + cycle * 864e5).toISOString().slice(0, 10) : null;
    const lead = Math.max(0, ...srcs.filter(s => s.active).map(s => Number(s.lead_days) || 0), 0);
    const daysLeft = perDay && on != null ? Math.floor(on / perDay) : null;
    const today = new Date().toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    let reorder = null;
    if (daysLeft != null && daysLeft <= lead + 7) reorder = 'stock: ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + ' left at the current pace';
    else if (next && next <= soon) reorder = next < today ? 'overdue by the usual cycle (expected ' + next + ')' : 'the usual cycle says ' + next;
    return { on_hand: on != null ? +on.toFixed(3) : null, last_count: lastCount ? lastCount.at : null, last_in: lastIn ? lastIn.at : null, receipts: ins.length,
      cycle_days: cycle, avg_in: avgIn, used_per_week: perDay ? +(perDay * 7).toFixed(2) : null, days_left: daysLeft, next_expected: next, reorder, entries: running.reverse() };
  }

  // ---- completeness: how well a material is described (what to fill next)
  function completeness(m, spec, srcs, phys) {
    const sr = SR(spec.form);
    const want = [['form', !!spec.form], ['thickness', !!spec.thickness || !!spec.stack_thick], ['color', !!(spec.color || spec.color_hex)], ['finish', !!spec.finish || spec.form === 'item'],
      ['base unit', !!spec.base_unit], ['weight', phys.per_unit_oz != null]];
    if (['item', 'liquid', 'sheet'].indexOf(spec.form) === -1) want.push(['adhesive', !!spec.adhesive]);
    if (sr) want.push(['printable', spec.sides != null && spec.sides !== ''], ['machines', spec.sides === '0' || spec.machines.length > 0]);
    if (sr) want.push(['material', !!spec.substrate]);
    if (spec.form === 'roll' || spec.form === 'wide_roll') want.push(['liner', !!spec.liner]);
    want.push(
      ['supplier', srcs.length > 0], ['cost', srcs.some(s => s.cost_per_buy != null)], ['size', srcs.some(s => s.unit_w && s.unit_h) || spec.form === 'item'],
      ['photo', !!(m.photo_url || m.website_image_url)]);
    const have = want.filter(w => w[1]).length;
    return { pct: Math.round(have * 100 / want.length), missing: want.filter(w => !w[1]).map(w => w[0]) };
  }

  // ---- seeding: every CRM material starts with the supplier it names (seller_id, else the free-text supplier matched to sellers)
  let seedBusy = false;
  async function seed(mats, sellers) {
    if (seedBusy) return 0; seedBusy = true; let n = 0;
    try {
      const done = new Set((await dbAll("SELECT value FROM ma_meta WHERE key LIKE 'seeded:%'")).map(r => Number(r.value)));
      const have = new Set((await dbAll('SELECT DISTINCT material_id FROM ma_sources')).map(r => r.material_id));
      for (const m of mats) {
        if (done.has(m.id) || have.has(m.id)) continue;
        let sel = null, how = null;
        if (Number(m.seller_id) > 0) { sel = sellers.find(s => s.id === Number(m.seller_id)) || null; how = 'CRM link'; }
        if (!sel && m.supplier) { const r = matchSeller(m.supplier, sellers); if (r) { sel = r.seller; how = 'matched "' + String(m.supplier).trim() + '" (' + r.how + ')'; } }
        if (sel || m.supplier) {
          const d = defaultsFor(m);
          await dbRun(`INSERT INTO ma_sources (material_id, seller_id, vendor_name, vendor_sku, buy_unit, units_per_buy, unit_w, unit_h, cost_per_buy, cost_from, preferred, match_how, created_by)
            VALUES (?,?,?,?,?,?,?,?,?,?,1,?,'crm')`, [m.id, sel ? sel.id : null, sel ? sel.company_name : String(m.supplier).trim(), m.code || null,
            d.form === 'roll' || d.form === 'wide_roll' ? 'roll' : d.form === 'item' ? 'each' : 'sheet', 1, Number(m.size_w) > 0 ? Number(m.size_w) : null, Number(m.size_h) > 0 ? Number(m.size_h) : null,
            Number(m.cost) > 0 ? Number(m.cost) : null, Number(m.cost) > 0 ? 'CRM cost' : null, sel ? how : 'not in Sellers — "' + String(m.supplier).trim() + '"']);
          n++;
        }
        await dbRun("INSERT OR IGNORE INTO ma_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))", ['seeded:' + m.id, String(m.id)]);
      }
    } catch (e) { errlog('seed', e.message); }
    seedBusy = false; return n;
  }

  // ---- the price check: every invoice line linked to a material, against that vendor's supplier item
  let sweepBusy = false, sweptAt = 0;
  async function sellerOfVendor(vendorId, vendorName, sellers) {
    if (vendorId) {
      const v = await dbGet('SELECT name, crm_id, details FROM bk_vendors WHERE id = ?', [vendorId]).catch(() => null);
      if (v) {
        if (v.crm_id && /"list"\s*:\s*"sellers"/.test(String(v.details || ''))) { const s = sellers.find(x => x.id === Number(v.crm_id)); if (s) return s; }
        const r = matchSeller(v.name, sellers); if (r) return r.seller;
      }
    }
    if (vendorName) { const r = matchSeller(vendorName, sellers); if (r) return r.seller; }
    return null;
  }
  async function sweep(force) {
    if (sweepBusy || (!force && Date.now() - sweptAt < 60e3)) return { skipped: true };
    sweepBusy = true; sweptAt = Date.now();
    const out = { lines: 0, prices: 0, alerts: 0, unmatched: 0, received: 0 }; const fresh = [];
    try {
      const s = await settings(), sellers = await crmSellers();
      const mats = await dbAll('SELECT id, crm_id FROM bk_materials').catch(() => []); const crmOf = {}; mats.forEach(m => { crmOf[m.id] = m.crm_id; });
      const seen = new Set((await dbAll('SELECT ref_kind, ref_id, ref_idx FROM ma_seen')).map(r => r.ref_kind + ':' + r.ref_id + ':' + r.ref_idx));
      const lines = [];
      const bills = await dbAll("SELECT id, vendor_id, vendor, invoice_no, invoice_date, created_at, lines, status FROM bk_bills WHERE lines LIKE '%material_id%' AND COALESCE(status,'') NOT IN ('rejected') AND merged_into IS NULL").catch(() =>
        dbAll("SELECT id, vendor_id, vendor, invoice_no, invoice_date, created_at, lines, status FROM bk_bills WHERE lines LIKE '%material_id%' AND COALESCE(status,'') NOT IN ('rejected')").catch(() => []));
      for (const b of bills) {
        let ls = []; try { ls = JSON.parse(b.lines || '[]'); } catch (e) {}
        ls.forEach((l, i) => { if (l && l.material_id) lines.push({ kind: 'bill', id: b.id, idx: i, vendor_id: b.vendor_id, vendor: b.vendor, at: b.invoice_date || String(b.created_at || '').slice(0, 10), mid: l.material_id, text: l.description, qty: l.qty, unit: l.unit_price, amount: l.amount, ref_no: b.invoice_no }); });
      }
      const items = await dbAll('SELECT i.id, i.name, i.qty, i.unit_price, i.amount, i.material_id, p.vendor_id, p.vendor, p.date, p.created_at FROM bk_purchase_items i JOIN bk_purchases p ON p.id = i.purchase_id WHERE i.material_id IS NOT NULL AND p.bill_id IS NULL AND COALESCE(p.cancelled,0) = 0').catch(() => []);
      items.forEach(it => lines.push({ kind: 'item', id: it.id, idx: 0, vendor_id: it.vendor_id, vendor: it.vendor, at: it.date || String(it.created_at || '').slice(0, 10), mid: it.material_id, text: it.name, qty: it.qty, unit: it.unit_price, amount: it.amount }));
      for (const L of lines) {
        const key = L.kind + ':' + L.id + ':' + L.idx; if (seen.has(key)) continue;
        out.lines++;
        const mid = crmOf[L.mid]; const qty = Number(L.qty) > 0 ? Number(L.qty) : null;
        const price = Number(L.unit) > 0 ? Number(L.unit) : (Number(L.amount) > 0 && qty ? Number(L.amount) / qty : null);
        if (!mid || !price) { await dbRun("INSERT OR IGNORE INTO ma_seen (ref_kind, ref_id, ref_idx, at) VALUES (?,?,?,datetime('now'))", [L.kind, L.id, L.idx]); continue; }
        const sel = await sellerOfVendor(L.vendor_id, L.vendor, sellers);
        const srcs = await dbAll('SELECT * FROM ma_sources WHERE material_id = ? AND active = 1', [mid]);
        let src = sel ? srcs.find(x => Number(x.seller_id) === sel.id) : null;
        if (!src && L.vendor) src = srcs.find(x => norm(x.vendor_name) && (norm(x.vendor_name) === norm(L.vendor) || norm(L.vendor).indexOf(norm(x.vendor_name)) === 0));
        if (!src) {
          await dbRun('INSERT INTO ma_unmatched (material_id, seller_id, vendor_name, ref_kind, ref_id, ref_idx, at, line_text, qty, price) VALUES (?,?,?,?,?,?,?,?,?,?)',
            [mid, sel ? sel.id : null, sel ? sel.company_name : L.vendor, L.kind, L.id, L.idx, L.at, String(L.text || '').slice(0, 300), qty, price]);
          out.unmatched++;
        } else {
          const per = Number(src.units_per_buy) > 0 ? Number(src.units_per_buy) : 1;
          const refBuy = src.cost_per_buy != null ? Number(src.cost_per_buy) : null, refUnit = refBuy != null ? refBuy / per : null;
          /* the invoice may price per carton or per sheet — compare with whichever reading is closer */
          let perWhat = 'buy', expected = refBuy;
          if (refBuy != null && per !== 1 && Math.abs(Math.log(price / refUnit)) < Math.abs(Math.log(price / refBuy))) { perWhat = 'unit'; expected = refUnit; }
          await dbRun('INSERT INTO ma_prices (source_id, material_id, at, price, per, unit_cost, qty, ref_kind, ref_id, ref_idx, line_text) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            [src.id, mid, L.at, price, perWhat, perWhat === 'buy' ? price / per : price, qty, L.kind, L.id, L.idx, String(L.text || '').slice(0, 300)]);
          out.prices++;
          if (expected == null) {
            await dbRun("UPDATE ma_sources SET cost_per_buy = ?, cost_date = ?, cost_from = ?, updated_at = datetime('now') WHERE id = ?", [perWhat === 'buy' ? price : price * per, L.at, src.confirmed ? 'first invoice' : 'first invoice — confirm the pack', src.id]);
          } else {
            const pct = (price - expected) / expected * 100;
            if (Math.abs(pct) >= Number(s.alert_pct || 10)) {
              const r = await dbRun('INSERT INTO ma_alerts (source_id, material_id, ref_kind, ref_id, ref_idx, at, line_text, per, expected, found, pct) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                [src.id, mid, L.kind, L.id, L.idx, L.at, String(L.text || '').slice(0, 300), perWhat, expected, price, +pct.toFixed(2)]);
              out.alerts++; fresh.push(r.lastID);
            }
          }
          if (!src.last_price_at || String(L.at) >= String(src.last_price_at)) await dbRun("UPDATE ma_sources SET last_price = ?, last_price_per = ?, last_price_at = ?, last_ref = ?, updated_at = datetime('now') WHERE id = ?", [price, perWhat, L.at, L.kind + ':' + L.id, src.id]);
          if (Number(s.invoice_receives) && qty && !src.confirmed) out.skipped_unconfirmed = (out.skipped_unconfirmed || 0) + 1;
          if (Number(s.invoice_receives) && qty && src.confirmed) {
            const spec = mergedSpec(await crmOne(mid), await dbGet('SELECT * FROM ma_specs WHERE material_id = ?', [mid])).spec;
            const y = yieldOf(src, spec) || 1, baseQty = perWhat === 'buy' ? qty * per * y : qty * y;
            await dbRun("INSERT INTO ma_stock (material_id, kind, qty, source_id, buy_qty, note, ref_kind, ref_id, ref_idx, by, at) VALUES (?,'receive',?,?,?,?,?,?,?,'invoice',?)",
              [mid, +baseQty.toFixed(3), src.id, qty, 'from ' + (L.kind === 'bill' ? 'bill #' + L.id + (L.ref_no ? ' (inv ' + L.ref_no + ')' : '') : 'purchase item'), L.kind, L.id, L.idx, L.at]);
            out.received++;
          }
        }
        await dbRun("INSERT OR IGNORE INTO ma_seen (ref_kind, ref_id, ref_idx, at) VALUES (?,?,?,datetime('now'))", [L.kind, L.id, L.idx]);
      }
      if (fresh.length) mailAlerts(fresh).catch(e => errlog('alert mail', e.message));
    } catch (e) { errlog('sweep', e.message); out.error = e.message; }
    sweepBusy = false; return out;
  }
  /* once a person confirms a supplier item (pack + size), the invoice lines already priced against it go into stock too */
  async function backfillReceipts(sourceId) {
    const s = await settings(); if (!Number(s.invoice_receives)) return 0;
    const src = await dbGet('SELECT * FROM ma_sources WHERE id = ?', [sourceId]); if (!src || !src.confirmed) return 0;
    const rows = await dbAll(`SELECT p.* FROM ma_prices p WHERE p.source_id = ? AND p.qty > 0 AND NOT EXISTS (SELECT 1 FROM ma_stock k WHERE k.ref_kind = p.ref_kind AND k.ref_id = p.ref_id AND k.ref_idx = p.ref_idx)`, [sourceId]);
    if (!rows.length) return 0;
    const spec = mergedSpec(await crmOne(src.material_id), await dbGet('SELECT * FROM ma_specs WHERE material_id = ?', [src.material_id])).spec;
    const y = yieldOf(src, spec) || 1, per = Number(src.units_per_buy) || 1;
    for (const p of rows) {
      const baseQty = p.per === 'unit' ? p.qty * y : p.qty * per * y;
      await dbRun("INSERT INTO ma_stock (material_id, kind, qty, source_id, buy_qty, note, ref_kind, ref_id, ref_idx, by, at) VALUES (?,'receive',?,?,?,?,?,?,?,'invoice',?)",
        [src.material_id, +baseQty.toFixed(3), src.id, p.qty, 'from ' + (p.ref_kind === 'bill' ? 'bill #' + p.ref_id : 'purchase item'), p.ref_kind, p.ref_id, p.ref_idx, p.at]);
    }
    return rows.length;
  }
  async function crmOne(id) { const all = await crmMaterials(); return all.find(m => m.id === Number(id)) || { id }; }
  const usd = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  async function mailAlerts(ids) {
    if (!sendMail) return;
    if (Notify && Notify.on && !Notify.on('ma.price')) return;
    const s = await settings();
    const rows = await dbAll('SELECT a.*, s.vendor_name FROM ma_alerts a LEFT JOIN ma_sources s ON s.id = a.source_id WHERE a.id IN (' + ids.map(Number).join(',') + ')');
    if (!rows.length) return;
    const mats = await crmMaterials(); const nm = (id) => (mats.find(m => m.id === id) || {}).name || ('material ' + id);
    const text = 'Material AI checked the latest invoices against the prices on file.\n\n' + rows.map(a => '• ' + nm(a.material_id) + ' — ' + (a.vendor_name || '?') + ': ' + usd(a.found) +
      ' per ' + (a.per === 'unit' ? 'piece' : 'buy unit') + ' vs ' + usd(a.expected) + ' on file (' + (a.pct > 0 ? '+' : '') + a.pct + '%) · ' + (a.at || '') + '\n   ' + (a.line_text || '')).join('\n') +
      '\n\nAccept the new price or mark it to renegotiate: https://nova.axiomprint.com/material-ai?tab=alerts';
    await sendMail({ to: Notify && Notify.to ? Notify.to('ma.price', s.alert_to) : s.alert_to, subject: 'Material AI: ' + rows.length + ' price' + (rows.length === 1 ? '' : 's') + ' off by ' + s.alert_pct + '%+', text });
    await dbRun("UPDATE ma_alerts SET mailed_at = datetime('now') WHERE id IN (" + rows.map(r => r.id).join(',') + ')');
  }
  setInterval(() => sweep(false).catch(() => {}), 20 * 60e3).unref();

  // ---- the list
  async function buildList(fresh) {
    const [mats, sellers, usage, geo] = await Promise.all([crmMaterials(fresh), crmSellers(fresh), crmUsage(fresh).catch(() => ({})), geoTree(fresh).catch(() => ({ byKey: {} }))]);
    await seed(mats, sellers);
    const specs = {}; (await dbAll('SELECT * FROM ma_specs')).forEach(r => { specs[r.material_id] = r; });
    const srcs = {}; (await dbAll('SELECT * FROM ma_sources ORDER BY preferred DESC, id')).forEach(r => { (srcs[r.material_id] = srcs[r.material_id] || []).push(r); });
    const stock = {}; (await dbAll('SELECT * FROM ma_stock ORDER BY at, id')).forEach(r => { (stock[r.material_id] = stock[r.material_id] || []).push(r); });
    const alerts = {}; (await dbAll("SELECT material_id, COUNT(*) n FROM ma_alerts WHERE status = 'open' GROUP BY material_id")).forEach(r => { alerts[r.material_id] = r.n; });
    const unmatched = {}; (await dbAll("SELECT material_id, COUNT(*) n FROM ma_unmatched WHERE status = 'open' GROUP BY material_id")).forEach(r => { unmatched[r.material_id] = r.n; });
    const sellerById = {}; sellers.forEach(s => { sellerById[s.id] = s; });
    return mats.map(m0 => { let m = m0;
      const ms = mergedSpec(m, specs[m.id]); ms.spec._material = m.material;
      const gk = ms.spec.geo_key && geo.byKey[ms.spec.geo_key]; if (gk) { m = Object.assign({}, m, { geo_type: gk.type_name, geo_sub_type: gk.key === gk.type_key ? null : gk.name }); }
      const ss = (srcs[m.id] || []).map(s => Object.assign(shapeSource(s, ms.spec), { seller: s.seller_id && sellerById[s.seller_id] ? { id: s.seller_id, name: sellerById[s.seller_id].company_name, photo: sellerById[s.seller_id].photo_url || null, email: sellerById[s.seller_id].email || null } : null }));
      const ph = physics(ms.spec, ss); const st = stockSummary(stock[m.id] || [], ss);
      delete st.entries;
      const best = ss.filter(s => s.active && s.cost_per_base != null).sort((a, b) => a.cost_per_base - b.cost_per_base)[0] || null;
      return { id: m.id, name: String(m.name || '').trim(), code: m.code, material: m.material, type: m.type, step: m.production_step, geo_type: m.geo_type, geo_sub_type: m.geo_sub_type,
        departments: m.departments, photo: m.photo_url || m.website_image_url || null, crm_supplier: m.supplier, crm_stock: m.stock, manufacturer: m.manufacturer,
        spec: ms.spec, spec_from: ms.from, base_label: baseLabel(ms.spec), sources: ss, best: best ? { id: best.id, vendor: best.vendor_name, cost_per_base: best.cost_per_base } : null,
        physics: ph, stock: st, usage: usage[m.id] || { options: 0, products: 0 }, alerts: alerts[m.id] || 0, unmatched: unmatched[m.id] || 0, completeness: completeness(m, ms.spec, ss, ph) };
    });
  }

  app.get('/material-ai', serveVersionedHtml('material-ai.html'));
  app.get('/api/material-ai/vocab', ...guard, (req, res) => res.json({ ok: true, vocab: VOCAB }));
  app.get('/api/material-ai/materials', ...guard, async (req, res) => {
    try {
      sweep(false).catch(() => {});
      const list = await buildList(req.query.fresh === '1');
      const s = await settings();
      const openAlerts = (await dbGet("SELECT COUNT(*) n FROM ma_alerts WHERE status = 'open'")).n;
      const openUnmatched = (await dbGet("SELECT COUNT(*) n FROM ma_unmatched WHERE status = 'open'")).n;
      res.json({ ok: true, materials: list, vocab: VOCAB, settings: s, counts: { alerts: openAlerts, unmatched: openUnmatched,
        reorder: list.filter(m => m.stock.reorder).length, tracked: list.filter(m => m.stock.on_hand != null).length } });
    } catch (e) { errlog('list', e.message); res.json({ ok: false, error: e.message }); }
  });
  app.get('/api/material-ai/materials/:id', ...guard, async (req, res) => {
    try {
      const id = parseInt(req.params.id); const list = await buildList(false); const m = list.find(x => x.id === id);
      if (!m) return res.json({ ok: false, error: 'No such material' });
      const stockRows = await dbAll('SELECT * FROM ma_stock WHERE material_id = ? ORDER BY at, id', [id]);
      m.stock = stockSummary(stockRows, m.sources);
      m.prices = await dbAll('SELECT p.*, s.vendor_name FROM ma_prices p LEFT JOIN ma_sources s ON s.id = p.source_id WHERE p.material_id = ? ORDER BY p.at DESC, p.id DESC LIMIT 60', [id]);
      m.alert_rows = await dbAll('SELECT a.*, s.vendor_name FROM ma_alerts a LEFT JOIN ma_sources s ON s.id = a.source_id WHERE a.material_id = ? ORDER BY a.id DESC LIMIT 30', [id]);
      m.unmatched_rows = await dbAll("SELECT * FROM ma_unmatched WHERE material_id = ? AND status = 'open' ORDER BY id DESC", [id]);
      try {
        m.used_in = await runQuery('SELECT DISTINCT p.id, COALESCE(NULLIF(p.public_title, \'\'), p.title) AS title, pv.title AS field, pvi.title AS option_title FROM product_variable_item pvi ' +
          'JOIN product_variables pv ON pv.id = pvi.variable_id JOIN product p ON p.id = pv.product_id WHERE pvi.material_id = ' + id + ' ORDER BY title LIMIT 60');
        m.used_in.forEach(u => { u.field = String(u.field || '').replace(/_/g, ' '); });
      } catch (e) { m.used_in = []; }
      res.json({ ok: true, material: m });
    } catch (e) { errlog('one', e.message); res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/material-ai/materials/:id/spec', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), b = req.body || {}; if (!id) return res.json({ ok: false, error: 'No material' });
    const vals = SPEC_FIELDS.map(f => {
      if (f === 'machines') return (Array.isArray(b.machines) ? b.machines : String(b.machines || '').split(',')).map(n => parseInt(n)).filter(n => n > 0).slice(0, 40).join(',') || null;
      if (f === 'color_hex') return /^#[0-9a-f]{6}$/i.test(String(b.color_hex || '')) ? String(b.color_hex).toLowerCase() : null;
      if (f === 'features') return (Array.isArray(b.features) ? b.features : String(b.features || '').split(',')).map(s => String(s).trim()).filter(Boolean).slice(0, 20).join(', ') || null;
      if (NUM_SPEC.indexOf(f) > -1) return num(b[f]);
      return str(b[f], f === 'notes' ? 1000 : 120);
    });
    await dbRun('INSERT INTO ma_specs (material_id, ' + SPEC_FIELDS.join(', ') + ', updated_by, updated_at) VALUES (?,' + SPEC_FIELDS.map(() => '?').join(',') + ",?,datetime('now')) " +
      'ON CONFLICT(material_id) DO UPDATE SET ' + SPEC_FIELDS.map(f => f + ' = excluded.' + f).join(', ') + ', updated_by = excluded.updated_by, updated_at = excluded.updated_at', [id].concat(vals, [userId(req)]));
    res.json({ ok: true });
  });
  app.get('/api/material-ai/geo', ...guard, async (req, res) => {
    try {
      const t = await geoTree(req.query.fresh === '1');
      const used = {}; (await buildList(false)).forEach(m => { const k = m.spec.geo_key; if (k) used[k] = (used[k] || 0) + 1; });
      t.types.forEach(x => { x.used = x.subs.reduce((n, y) => n + (used[y.key] || 0), used[x.key] || 0); x.subs.forEach(y => { y.used = used[y.key] || 0; }); });
      res.json({ ok: true, types: t.types });
    } catch (e) { errlog('geo', e.message); res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/material-ai/geo', ...guard, async (req, res) => {
    const b = req.body || {}, who = userId(req), op = String(b.op || ''), key = String(b.key || '');
    const m = key.match(/^(c|n)(t|s)(\d+)$/), name = str(b.name, 80), abbr = b.abbr == null ? null : (String(b.abbr).trim().toUpperCase().slice(0, 12));
    try {
      if (op === 'add') {
        const kind = b.kind === 'type' ? 'type' : 'sub', parent = kind === 'sub' ? String(b.parent || '') : null;
        if (!name) return res.json({ ok: false, error: 'Give it a name' });
        if (kind === 'sub' && !/^(c|n)t\d+$/.test(parent)) return res.json({ ok: false, error: 'Which geo type?' });
        const r = await dbRun("INSERT INTO ma_geo (kind, parent, name, abbr, updated_by, updated_at) VALUES (?,?,?,?,?,datetime('now'))", [kind, parent, name, abbr, who]);
        return res.json({ ok: true, key: 'n' + (kind === 'type' ? 't' : 's') + r.lastID });
      }
      if (!m) return res.json({ ok: false, error: 'Unknown geo type' });
      const kind = m[2] === 't' ? 'type' : 'sub', id = Number(m[3]);
      let row = m[1] === 'n' ? await dbGet('SELECT * FROM ma_geo WHERE id = ? AND kind = ? AND crm_id IS NULL', [id, kind]) : await dbGet('SELECT * FROM ma_geo WHERE kind = ? AND crm_id = ?', [kind, id]);
      if (!row && m[1] === 'n') return res.json({ ok: false, error: 'Not found' });
      if (!row) { const r = await dbRun("INSERT INTO ma_geo (kind, crm_id, updated_by, updated_at) VALUES (?,?,?,datetime('now'))", [kind, id, who]); row = { id: r.lastID }; }
      if (op === 'save') {
        if (b.name !== undefined && !name && m[1] === 'n') return res.json({ ok: false, error: 'Give it a name' });
        const sets = [], vals = [];
        if (b.name !== undefined) { sets.push('name = ?'); vals.push(name); }
        if (b.abbr !== undefined && kind === 'sub') { sets.push('abbr = ?'); vals.push(abbr); }
        if (!sets.length) return res.json({ ok: true });
        await dbRun('UPDATE ma_geo SET ' + sets.join(', ') + ", updated_by = ?, updated_at = datetime('now') WHERE id = ?", vals.concat([who, row.id]));
      } else if (op === 'remove' || op === 'restore') {
        if (op === 'remove' && m[1] === 'n') {
          const inUse = (await dbGet('SELECT COUNT(*) n FROM ma_specs WHERE geo_key = ?', [key])).n;
          const kids = kind === 'type' ? (await dbGet("SELECT COUNT(*) n FROM ma_geo WHERE kind = 'sub' AND parent = ? AND hidden = 0", [key])).n : 0;
          if (!inUse && !kids) { await dbRun('DELETE FROM ma_geo WHERE id = ?', [row.id]); return res.json({ ok: true, deleted: true }); }
        }
        await dbRun("UPDATE ma_geo SET hidden = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?", [op === 'remove' ? 1 : 0, who, row.id]);
      } else return res.json({ ok: false, error: 'Unknown action' });
      res.json({ ok: true });
    } catch (e) { errlog('geo save', e.message); res.json({ ok: false, error: e.message }); }
  });
  /* the machines a material can run on — CRM equipments, printers first (an action named "Print …"), read-only */
  const crmMachines = (fresh) => cached('machines', 30 * 60e3, async () => {
    const eq = await runQuery('SELECT id, name, photo_url, action_ids FROM equipments ORDER BY name');
    const acts = {}; (await runQuery('SELECT a.id, a.name, t.name AS team FROM actions a LEFT JOIN team t ON t.id = a.team_id')).forEach(a => { acts[a.id] = a; });
    return eq.map(e => {
      let ids = e.action_ids; try { if (typeof ids === 'string') ids = JSON.parse(ids); } catch (x) { ids = []; }
      const a = (Array.isArray(ids) ? ids : []).map(i => acts[i]).filter(Boolean);
      const pr = a.filter(x => /^print\b/i.test(String(x.name || '').trim()));
      return { id: e.id, name: String(e.name || '').trim(), photo: e.photo_url || null, prints: pr.length > 0, team: (pr[0] || a[0] || {}).team || null,
        does: (pr.length ? pr : a).map(x => String(x.name || '').replace(/^print\s*-\s*/i, '')).slice(0, 4) };
    }).sort((x, y) => (y.prints - x.prints) || String(x.team || '').localeCompare(String(y.team || '')) || x.name.localeCompare(y.name));
  }, fresh);
  app.get('/api/material-ai/machines', ...guard, async (req, res) => {
    try { res.json({ ok: true, machines: await crmMachines(req.query.fresh === '1') }); } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.get('/api/material-ai/sellers', ...guard, async (req, res) => {
    try { const s = await crmSellers(req.query.fresh === '1'); res.json({ ok: true, sellers: s.map(x => ({ id: x.id, name: x.company_name, type: x.type, specialty: x.specialty, photo: x.photo_url, email: x.email })) }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/material-ai/materials/:id/sources', ...guard, async (req, res) => {
    const mid = parseInt(req.params.id), b = req.body || {}, who = userId(req); if (!mid) return res.json({ ok: false, error: 'No material' });
    const sellers = await crmSellers().catch(() => []);
    const sid = parseInt(b.seller_id) || null, sel = sid ? sellers.find(s => s.id === sid) : null;
    const name = sel ? sel.company_name : str(b.vendor_name, 200); if (!name) return res.json({ ok: false, error: 'Pick the supplier' });
    const BUY = VOCAB.buy_unit.map(x => x[0]);
    const vals = [sid, name, str(b.vendor_sku, 120), str(b.vendor_desc, 300), BUY.indexOf(b.buy_unit) > -1 ? b.buy_unit : 'sheet', num(b.units_per_buy) > 0 ? num(b.units_per_buy) : 1,
      num(b.unit_w), num(b.unit_h), num(b.yield_override) > 0 ? num(b.yield_override) : null, num(b.cost_per_buy), num(b.lead_days) != null ? Math.round(num(b.lead_days)) : null,
      str(b.min_order, 80), str(b.notes, 500), b.active === false || b.active === 0 ? 0 : 1];
    let id = parseInt(b.id) || null;
    if (id) {
      const old = await dbGet('SELECT * FROM ma_sources WHERE id = ? AND material_id = ?', [id, mid]); if (!old) return res.json({ ok: false, error: 'No such supplier item' });
      const costChanged = num(b.cost_per_buy) !== (old.cost_per_buy == null ? null : Number(old.cost_per_buy));
      await dbRun(`UPDATE ma_sources SET seller_id = ?, vendor_name = ?, vendor_sku = ?, vendor_desc = ?, buy_unit = ?, units_per_buy = ?, unit_w = ?, unit_h = ?, yield_override = ?, cost_per_buy = ?,
        lead_days = ?, min_order = ?, notes = ?, active = ?, match_how = CASE WHEN ? IS NOT NULL AND COALESCE(seller_id,0) <> ? THEN 'set by hand' ELSE match_how END,
        cost_date = CASE WHEN ? THEN date('now') ELSE cost_date END, cost_from = CASE WHEN ? THEN 'typed by ' || ? ELSE cost_from END, confirmed = 1, updated_at = datetime('now') WHERE id = ?`,
        vals.concat([sid, sid || 0, costChanged ? 1 : 0, costChanged ? 1 : 0, who, id]));
    } else {
      const first = !(await dbGet('SELECT id FROM ma_sources WHERE material_id = ? AND active = 1', [mid]));
      const r = await dbRun(`INSERT INTO ma_sources (seller_id, vendor_name, vendor_sku, vendor_desc, buy_unit, units_per_buy, unit_w, unit_h, yield_override, cost_per_buy, lead_days, min_order, notes, active,
        material_id, preferred, match_how, cost_date, cost_from, created_by, confirmed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'set by hand',date('now'),?,?,1)`, vals.concat([mid, first ? 1 : 0, num(b.cost_per_buy) != null ? 'typed by ' + who : null, who]));
      id = r.lastID;
    }
    if (b.preferred) { await dbRun('UPDATE ma_sources SET preferred = 0 WHERE material_id = ?', [mid]); await dbRun('UPDATE ma_sources SET preferred = 1 WHERE id = ?', [id]); }
    const received = await backfillReceipts(id).catch(e => { errlog('backfill', e.message); return 0; });
    res.json({ ok: true, id, received });
  });
  app.post('/api/material-ai/sources/:id/preferred', ...guard, async (req, res) => {
    const s = await dbGet('SELECT material_id FROM ma_sources WHERE id = ?', [parseInt(req.params.id)]); if (!s) return res.json({ ok: false, error: 'No such supplier item' });
    await dbRun('UPDATE ma_sources SET preferred = 0 WHERE material_id = ?', [s.material_id]); await dbRun('UPDATE ma_sources SET preferred = 1 WHERE id = ?', [parseInt(req.params.id)]);
    res.json({ ok: true });
  });
  app.post('/api/material-ai/sources/:id/delete', ...guard, async (req, res) => {
    const id = parseInt(req.params.id); const used = await dbGet('SELECT COUNT(*) n FROM ma_prices WHERE source_id = ?', [id]);
    if (used && used.n) { await dbRun("UPDATE ma_sources SET active = 0, preferred = 0, updated_at = datetime('now') WHERE id = ?", [id]); return res.json({ ok: true, archived: true }); }
    await dbRun('DELETE FROM ma_sources WHERE id = ?', [id]); res.json({ ok: true });
  });

  // stock: a receipt or a count ("what is left?") — qty in base units, or in buy units of a supplier item
  app.post('/api/material-ai/materials/:id/stock', ...guard, async (req, res) => {
    const mid = parseInt(req.params.id), b = req.body || {}; const kind = ['receive', 'count', 'adjust'].indexOf(b.kind) > -1 ? b.kind : null;
    let qty = num(b.qty); if (!mid || !kind || qty == null || (kind !== 'adjust' && qty < 0)) return res.json({ ok: false, error: 'Give a quantity' });
    let buyQty = null, sid = parseInt(b.source_id) || null;
    if (b.unit === 'buy' && sid) {
      const src = await dbGet('SELECT * FROM ma_sources WHERE id = ? AND material_id = ?', [sid, mid]); if (!src) return res.json({ ok: false, error: 'No such supplier item' });
      const spec = mergedSpec(await crmOne(mid), await dbGet('SELECT * FROM ma_specs WHERE material_id = ?', [mid])).spec;
      const y = yieldOf(src, spec) || 1; buyQty = qty; qty = qty * (Number(src.units_per_buy) || 1) * y;
    }
    const at = /^\d{4}-\d{2}-\d{2}$/.test(String(b.at || '')) ? b.at : new Date().toISOString().slice(0, 19).replace('T', ' ');
    await dbRun('INSERT INTO ma_stock (material_id, kind, qty, source_id, buy_qty, location, note, by, at) VALUES (?,?,?,?,?,?,?,?,?)', [mid, kind, +qty.toFixed(3), sid, buyQty, str(b.location, 80), str(b.note, 300), userId(req), at]);
    res.json({ ok: true, qty: +qty.toFixed(3) });
  });
  app.post('/api/material-ai/stock/:id/delete', ...guard, async (req, res) => { await dbRun('DELETE FROM ma_stock WHERE id = ?', [parseInt(req.params.id)]); res.json({ ok: true }); });

  // price alerts + invoice lines whose vendor has no supplier item for that material yet
  app.get('/api/material-ai/alerts', ...guard, async (req, res) => {
    try {
      await sweep(req.query.fresh === '1');
      const mats = await crmMaterials(); const nm = {}; mats.forEach(m => { nm[m.id] = { name: String(m.name || '').trim(), photo: m.photo_url || m.website_image_url || null }; });
      const open = await dbAll("SELECT a.*, s.vendor_name, s.seller_id, s.units_per_buy, s.buy_unit, s.cost_per_buy FROM ma_alerts a LEFT JOIN ma_sources s ON s.id = a.source_id WHERE a.status = 'open' ORDER BY a.at DESC, a.id DESC");
      const done = await dbAll("SELECT a.*, s.vendor_name FROM ma_alerts a LEFT JOIN ma_sources s ON s.id = a.source_id WHERE a.status <> 'open' ORDER BY a.decided_at DESC LIMIT 40");
      const um = await dbAll("SELECT * FROM ma_unmatched WHERE status = 'open' ORDER BY at DESC, id DESC");
      const sellers = await crmSellers(); const em = {}; sellers.forEach(s => { em[s.id] = s.email || null; });
      [open, done, um].forEach(list => list.forEach(a => { a.material = nm[a.material_id] || { name: 'material ' + a.material_id }; if (a.seller_id) a.vendor_email = em[a.seller_id] || null; }));
      res.json({ ok: true, open, done, unmatched: um, settings: await settings() });
    } catch (e) { errlog('alerts', e.message); res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/material-ai/alerts/:id', ...guard, async (req, res) => {
    const id = parseInt(req.params.id), act = String((req.body || {}).action || ''); const a = await dbGet('SELECT * FROM ma_alerts WHERE id = ?', [id]);
    if (!a) return res.json({ ok: false, error: 'No such alert' });
    if (['accept', 'renegotiate', 'dismiss', 'reopen'].indexOf(act) === -1) return res.json({ ok: false, error: 'Unknown action' });
    if (act === 'accept') {
      const src = await dbGet('SELECT * FROM ma_sources WHERE id = ?', [a.source_id]);
      if (src) { const per = Number(src.units_per_buy) || 1; await dbRun("UPDATE ma_sources SET cost_per_buy = ?, cost_date = ?, cost_from = ?, updated_at = datetime('now') WHERE id = ?", [a.per === 'unit' ? a.found * per : a.found, a.at, 'accepted from invoice by ' + userId(req), src.id]); }
    }
    await dbRun("UPDATE ma_alerts SET status = ?, note = COALESCE(?, note), decided_by = ?, decided_at = datetime('now') WHERE id = ?", [act === 'reopen' ? 'open' : act === 'accept' ? 'accepted' : act === 'renegotiate' ? 'renegotiate' : 'dismissed', str((req.body || {}).note, 500), userId(req), id]);
    res.json({ ok: true });
  });
  app.post('/api/material-ai/unmatched/:id/:act', ...guard, async (req, res) => {
    const u = await dbGet('SELECT * FROM ma_unmatched WHERE id = ?', [parseInt(req.params.id)]); if (!u) return res.json({ ok: false, error: 'Not found' });
    if (req.params.act === 'dismiss') { await dbRun("UPDATE ma_unmatched SET status = 'dismissed' WHERE id = ?", [u.id]); return res.json({ ok: true }); }
    if (req.params.act !== 'add') return res.json({ ok: false, error: 'Unknown action' });
    const r = await dbRun(`INSERT INTO ma_sources (material_id, seller_id, vendor_name, vendor_desc, buy_unit, units_per_buy, cost_per_buy, cost_date, cost_from, match_how, created_by)
      VALUES (?,?,?,?,'sheet',1,?,?,'invoice line','from an invoice line',?)`, [u.material_id, u.seller_id, u.vendor_name || 'Unknown vendor', u.line_text, u.price, u.at, userId(req)]);
    await dbRun("UPDATE ma_unmatched SET status = 'added' WHERE id = ?", [u.id]);
    await dbRun('DELETE FROM ma_seen WHERE ref_kind = ? AND ref_id = ? AND ref_idx = ?', [u.ref_kind, u.ref_id, u.ref_idx]);   /* re-read on the next sweep: price + receipt */
    sweptAt = 0; res.json({ ok: true, id: r.lastID });
  });
  app.get('/api/material-ai/settings', ...guard, async (req, res) => res.json({ ok: true, settings: await settings() }));
  app.post('/api/material-ai/settings', ...guard, async (req, res) => {
    const b = req.body || {}, cur = await settings();
    const next = { alert_pct: Math.min(90, Math.max(1, num(b.alert_pct) || cur.alert_pct)), invoice_receives: b.invoice_receives === undefined ? cur.invoice_receives : (b.invoice_receives ? 1 : 0),
      alert_to: str(b.alert_to, 300) || cur.alert_to, reorder_days: Math.min(60, Math.max(1, num(b.reorder_days) || cur.reorder_days)) };
    await setMeta('settings', JSON.stringify(next)); res.json({ ok: true, settings: next });
  });
  app.post('/api/material-ai/sweep', ...guard, async (req, res) => res.json(Object.assign({ ok: true }, await sweep(true))));

  return { sweep, buildList, matchSeller, yieldOf, physics, stockSummary, defaultsFor };
};
