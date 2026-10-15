/**
 * Website knowledge — what axiomprint.com says about each product, and the blog (1.20.50).
 *
 * The production DB has the catalog (options, formulas, prices) but not the words the website uses: SEO
 * keywords and research, the AI-training Q&A the team writes, product FAQs, guideline tabs, page copy and the
 * articles. The web team exposes those read-only at `https://website.workroomapp.com/api/v1/nova`
 * (spec: docs/NOVA_WEBSITE_KNOWLEDGE.md — the hand-off "Nova AI — Product Knowledge, SEO, AI Training and
 * Articles"). Live calls per question would slow every chat down, so this module MIRRORS the lists into SQLite
 * (`wk_products`, `wk_articles`, `wk_meta`) — a full page-through on first boot, then `updatedSince` refreshes
 * every REFRESH_MIN minutes — and keeps everything in memory for search. One product is re-read live
 * (`product(id, { fresh: true })`, 4 s budget, falls back to the mirror) when a chat asks about it, as the spec
 * asks.
 *
 * Three consumers: the client bot's search_products / product_knowledge / articles, TalkAi (the same tools),
 * and the staff ChatBot, which alone may see `seo.keyword_analysis` (search volume, difficulty) — marketing
 * research that customers must never hear (`knowledgeFor(..., { internal })`, `keywords()`).
 *
 * Restricted products (`restricted_to_customers` non-empty) never come in the list; a direct read returns them,
 * and `visibleTo(rec, customerId)` is the one check before a record is shown to anyone but staff.
 */
module.exports = function websiteKnowledge(opts) {
  const db = opts.db;
  const BASE = (process.env.NOVA_KNOWLEDGE_API || 'https://website.workroomapp.com/api/v1/nova').replace(/\/+$/, '');
  const REFRESH_MIN = Math.max(15, parseInt(process.env.NOVA_KNOWLEDGE_REFRESH_MIN) || 360);
  const OFF = /^(0|false|off)$/i.test(String(process.env.NOVA_KNOWLEDGE || '1'));
  const log = (...a) => console.log('WEBSITE-KNOWLEDGE', ...a);

  db.serialize(() => {
    db.run('CREATE TABLE IF NOT EXISTS wk_products (product_id INTEGER PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT, fetched_at TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS wk_articles (slug TEXT PRIMARY KEY, id INTEGER, json TEXT NOT NULL, updated_at TEXT, fetched_at TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS wk_meta (key TEXT PRIMARY KEY, value TEXT)');
  });
  const dbAll = (sql, p) => new Promise((ok, no) => db.all(sql, p || [], (e, r) => e ? no(e) : ok(r || [])));
  const dbRun = (sql, p) => new Promise((ok, no) => db.run(sql, p || [], function (e) { e ? no(e) : ok(this); }));
  const dbGet = (sql, p) => new Promise((ok, no) => db.get(sql, p || [], (e, r) => e ? no(e) : ok(r || null)));

  // ---- in-memory mirror -------------------------------------------------------------------------------------
  const products = new Map();   // product_id -> record (+ _idx)
  const articles = new Map();   // slug -> record (+ _idx)
  let loaded = false, loadingP = null, lastRefresh = null, lastError = null, refreshing = false;

  const STOP = new Set(('a an the and or of for to in on with by from at is are be as it its this that these those my our your we i you ' +
    'need want like get have how much many do does can could would should what which who where when why please hi hello thanks ' +
    'print printing printed custom order quote price cost about some any one').split(' '));
  const stem = (w) => {
    const t = String(w || '').toLowerCase();
    if (t.length > 5 && /ing$/.test(t)) return t.slice(0, -3);
    if (t.length > 4 && /ed$/.test(t)) return t.slice(0, -2);
    if (t.length > 4 && /ies$/.test(t)) return t.slice(0, -3) + 'y';
    if (t.length > 4 && /es$/.test(t)) return t.slice(0, -2);
    if (t.length > 3 && /s$/.test(t)) return t.slice(0, -1);
    return t;
  };
  const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9#. ]+/g, ' ').split(/\s+/)
    .map(w => w.replace(/^\.+|\.+$/g, '')).filter(w => w.length >= 2 && !STOP.has(w)).map(stem);
  const uniq = (a) => a.filter((x, i) => a.indexOf(x) === i);
  const text = (v) => Array.isArray(v) ? v.map(text).join(' ') : (v && typeof v === 'object') ? Object.values(v).map(text).join(' ') : String(v == null ? '' : v);

  // Per-record search index: field groups → set of stems and the lower-cased phrase text (for phrase hits).
  function indexProduct(p) {
    const seo = p.seo || {};
    const kwList = [].concat(seo.meta_keywords || [], seo.target_keywords || [], (seo.keyword_analysis || []).map(k => k && k.keyword));
    const groups = {
      name: text([p.public_title, p.title]),
      cat: text([p.category, p.subcategory]),
      kw: text(kwList),
      meta: text([seo.meta_title, seo.meta_description]),
      train: text((p.ai_training || []).map(x => x && x.question)),
      faq: text((p.faqs || []).map(x => x && x.question)),
      body: text([p.content && p.content.information, p.content && p.content.short_description, p.content && p.content.description]).slice(0, 4000)
    };
    const idx = {};
    Object.keys(groups).forEach(k => { idx[k] = { set: new Set(words(groups[k])), low: ' ' + groups[k].toLowerCase().replace(/\s+/g, ' ') + ' ' }; });
    // phrases are kept stemmed ("lay flat books" → "lay flat book") so plural / hyphen differences still hit
    idx.phrases = uniq(kwList.filter(Boolean).map(k => words(k).join(' ')).filter(k => k.length >= 5));
    p._idx = idx;
    return p;
  }
  function indexArticle(a) {
    const groups = {
      name: text([a.title, a.description]),
      kw: text([a.tags, a.seo && a.seo.keywords, a.category && a.category.title]),
      body: text(a.content).slice(0, 6000)
    };
    const idx = {};
    Object.keys(groups).forEach(k => { idx[k] = { set: new Set(words(groups[k])), low: ' ' + groups[k].toLowerCase().replace(/\s+/g, ' ') + ' ' }; });
    a._idx = idx;
    return a;
  }

  async function loadFromDb() {
    const pr = await dbAll('SELECT json FROM wk_products');
    products.clear();
    pr.forEach(r => { try { const p = JSON.parse(r.json); if (p && p.product_id) products.set(Number(p.product_id), indexProduct(p)); } catch (e) {} });
    const ar = await dbAll('SELECT json FROM wk_articles');
    articles.clear();
    ar.forEach(r => { try { const a = JSON.parse(r.json); if (a && a.slug) articles.set(String(a.slug), indexArticle(a)); } catch (e) {} });
    const m = await dbGet("SELECT value FROM wk_meta WHERE key = 'last_refresh'");
    lastRefresh = m ? m.value : null;
    loaded = true;
  }

  // ---- the API --------------------------------------------------------------------------------------------
  async function getJson(path, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms || 15000);
    try {
      const r = await fetch(BASE + path, { headers: { 'Accept': 'application/json', 'User-Agent': 'NovaAI/1.0 (+nova.axiomprint.com)' }, signal: ctl.signal });
      if (r.status === 404) return { notFound: true };
      if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + path);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  const strip = (p) => { const c = Object.assign({}, p); delete c._idx; return c; };
  async function saveProduct(p) {
    await dbRun('INSERT INTO wk_products (product_id, json, updated_at, fetched_at) VALUES (?,?,?,datetime(\'now\')) ON CONFLICT(product_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at, fetched_at = excluded.fetched_at',
      [Number(p.product_id), JSON.stringify(strip(p)), p.updated_at || null]);
    products.set(Number(p.product_id), indexProduct(Object.assign({}, p)));
  }
  async function saveArticle(a) {
    await dbRun('INSERT INTO wk_articles (slug, id, json, updated_at, fetched_at) VALUES (?,?,?,?,datetime(\'now\')) ON CONFLICT(slug) DO UPDATE SET id = excluded.id, json = excluded.json, updated_at = excluded.updated_at, fetched_at = excluded.fetched_at',
      [String(a.slug), Number(a.id) || null, JSON.stringify(strip(a)), a.updated_at || null]);
    articles.set(String(a.slug), indexArticle(Object.assign({}, a)));
  }
  async function pageThrough(kind, since) {
    const key = kind === 'products' ? 'products' : 'articles';
    let page = 1, got = 0, total = Infinity, n = 0;
    while (got < total && page <= 200) {
      const j = await getJson('/' + key + '?page=' + page + '&perPage=100' + (since ? '&updatedSince=' + encodeURIComponent(since) : ''));
      const list = Array.isArray(j[key]) ? j[key] : [];
      total = Number(j.total) || 0;
      for (const rec of list) { if (kind === 'products') await saveProduct(rec); else await saveArticle(rec); n++; }
      got += list.length;
      if (!list.length) break;
      page++;
    }
    return n;
  }
  // full = everything; else only what changed since the last refresh (the spec's updatedSince).
  async function refresh(full) {
    if (OFF || refreshing) return { skipped: true };
    refreshing = true;
    const started = new Date().toISOString();
    try {
      const since = full || !lastRefresh ? null : lastRefresh.slice(0, 10);
      const np = await pageThrough('products', since);
      const na = await pageThrough('articles', since);
      lastRefresh = started; lastError = null;
      await dbRun("INSERT INTO wk_meta (key, value) VALUES ('last_refresh', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [started]);
      log((since ? 'refresh since ' + since : 'full load') + ': ' + np + ' products, ' + na + ' articles (' + products.size + ' / ' + articles.size + ' kept)');
      return { ok: true, products: np, articles: na, full: !since };
    } catch (e) {
      lastError = e.message; log('refresh failed:', e.message);
      return { ok: false, error: e.message };
    } finally { refreshing = false; }
  }
  function ready() {
    if (loaded) return Promise.resolve();
    if (!loadingP) loadingP = loadFromDb().catch(e => { log('load failed', e.message); loaded = true; });
    return loadingP;
  }
  // Boot: mirror from SQLite at once (fast), then a full load when empty or a day old, else a delta.
  ready().then(() => {
    if (OFF) return log('off (NOVA_KNOWLEDGE=0)');
    const ageH = lastRefresh ? (Date.now() - Date.parse(lastRefresh)) / 36e5 : Infinity;
    setTimeout(() => refresh(!products.size || ageH > 24), 5000).unref();
    setInterval(() => refresh(false), REFRESH_MIN * 60000).unref();
  });

  // ---- reads ----------------------------------------------------------------------------------------------
  function visibleTo(rec, customerId) {
    const r = rec && Array.isArray(rec.restricted_to_customers) ? rec.restricted_to_customers : [];
    if (!r.length) return true;
    const cid = parseInt(customerId);
    return cid > 0 && r.some(x => parseInt(x) === cid);
  }
  async function product(id, o) {
    await ready();
    id = parseInt(id);
    if (!(id > 0)) return null;
    const have = products.get(id) || null;
    if (!(o && o.fresh) || OFF) return have;
    try {
      const j = await getJson('/products/' + id, (o && o.ms) || 4000);
      if (j && j.notFound) return null;
      if (j && j.product_id) { await saveProduct(j); return products.get(id); }
    } catch (e) {}
    return have;
  }

  // Score the mirror against the customer's words. Returns [{product_id, public_title, url, category, score, why}].
  async function search(query, o) {
    await ready();
    o = o || {};
    const qs = uniq(words(query));
    const qlow = ' ' + words(query).join(' ') + ' ';   // stemmed, like the index
    if (!qs.length) return [];
    const W = { name: 6, cat: 3, kw: 4, meta: 2.5, train: 3, faq: 2, body: 1 };
    const out = [];
    products.forEach(p => {
      if (!visibleTo(p, o.customerId) && !o.internal) return;
      const idx = p._idx; let score = 0; const hit = new Set(); const why = [];
      Object.keys(W).forEach(k => { const g = idx[k]; if (!g) return; qs.forEach(w => { if (g.set.has(w)) { score += W[k]; hit.add(w); } }); });
      // A whole keyword phrase of the product found in the question ("lay flat book", "spot uv") is the strongest signal.
      let phrase = null;
      idx.phrases.forEach(ph => { if (ph.length >= 5 && qlow.indexOf(' ' + ph + ' ') > -1 && (!phrase || ph.length > phrase.length)) phrase = ph; });
      if (phrase) { score += 10 + Math.min(10, phrase.split(' ').length * 3); why.push('site keyword "' + phrase + '"'); }
      if (qs.length >= 2 && qs.every(w => idx.name.set.has(w))) { score += 12; why.push('name'); }
      const cover = hit.size / qs.length;
      if (!hit.size && !phrase) return;
      score = score * (0.5 + cover / 2);
      if (!why.length && hit.size) why.push('matches ' + [...hit].slice(0, 4).join(', '));
      out.push({ product_id: p.product_id, public_title: p.public_title || p.title, title: p.title, url: p.url, category: p.category || null,
        subcategory: p.subcategory || null, image: p.image || null, score: Math.round(score * 10) / 10, cover: cover, why: why.join(' · ') });
    });
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, o.limit || 10);
  }

  // The knowledge text for one product, in the spec's trust order, within a character budget. `question` pulls
  // the FAQ / tab / training items that share words with it to the front. Internal readers may also get the SEO
  // research; customers never do.
  function knowledgeFor(p, question, o) {
    if (!p) return null;
    o = o || {};
    const budget = o.budget || 7000;
    const qs = new Set(words(question || ''));
    const rel = (s) => { if (!qs.size) return 0; let n = 0; words(s).forEach(w => { if (qs.has(w)) n++; }); return n; };
    const cut = (s, n) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, n - 1).trim() + '…' : s; };
    const qa = (list, cap) => (list || []).filter(x => x && (x.question || x.answer)).map(x => ({ q: cut(x.question, 200), a: cut(x.answer, cap || 900), r: rel(x.question + ' ' + x.answer) }))
      .sort((a, b) => b.r - a.r).map(x => ({ question: x.q, answer: x.a }));
    const out = {
      product_id: p.product_id, name: p.public_title || p.title, url: p.url, category: p.category || null, subcategory: p.subcategory || null,
      summary: cut(p.seo && p.seo.meta_description, 300) || null,
      trust_order: 'team_answers > faqs > tabs > page_text. Quote facts as written; never invent options, prices or turnaround.'
    };
    let used = 400;
    const take = (key, val, size) => { if (val == null || (Array.isArray(val) && !val.length) || val === '') return; if (used + size > budget) return; out[key] = val; used += size; };
    const ta = qa(p.ai_training, 1200); take('team_answers', ta, JSON.stringify(ta).length);
    const fq = qa(p.faqs, 700); take('faqs', fq, JSON.stringify(fq).length);
    const tabs = (p.tabs || []).map(t => t && t.type === 'question&answer' ? { tab: t.name, questions: qa(t.questions, 500) } : { tab: t && t.name, text: cut(t && t.text, 1500), r: rel(t && t.text) })
      .filter(t => (t.questions && t.questions.length) || t.text).sort((a, b) => (b.r || 0) - (a.r || 0)).map(t => { delete t.r; return t; });
    take('tabs', tabs, JSON.stringify(tabs).length);
    const c = p.content || {};
    const page = {};
    [['information', 1800], ['short_description', 400], ['description', 800], ['about', 600], ['additional_info', 600], ['file_prep', 900], ['finishing', 600], ['turnaround_and_shipping', 600], ['turnaround_tooltip', 300], ['templates_information', 500]]
      .forEach(([k, n]) => { if (c[k]) page[k] = cut(c[k], n); });
    if (!Object.keys(page).length && p.faq_text) page.faq_text = cut(p.faq_text, 1200);
    take('page_text', page, JSON.stringify(page).length);
    if (p.artwork && (p.artwork.bleed || p.artwork.dpi)) out.artwork = { bleed_inches_total: p.artwork.bleed, dpi: p.artwork.dpi };
    if (p.samples) out.samples = p.samples;
    const opts = (p.options || []).filter(x => x && !x.hidden && x.key && !/quantity|version/i.test(x.key))
      .map(x => ({ option: x.key, choices: (x.choices || []).slice(0, 25), default: x.default || undefined }));
    take('options_in_words', opts, JSON.stringify(opts).length);
    if (o.internal && p.seo) out.seo_internal = keywordsOf(p);
    return out;
  }
  function keywordsOf(p) {
    const seo = p.seo || {};
    return {
      product_id: p.product_id, name: p.public_title || p.title, url: p.url,
      meta_title: seo.meta_title || null, meta_description: seo.meta_description || null,
      meta_keywords: seo.meta_keywords || [], target_keywords: seo.target_keywords || [],
      keyword_analysis: (seo.keyword_analysis || []).filter(Boolean).map(k => ({ keyword: k.keyword, search_volume: k.search_volume, difficulty: k.difficulty }))
        .sort((a, b) => (Number(b.search_volume) || 0) - (Number(a.search_volume) || 0)),
      internal_only: 'Marketing research for the team. Never shown or quoted to customers.'
    };
  }
  async function keywords(idOrQuery) {
    await ready();
    const id = parseInt(idOrQuery);
    if (id > 0 && products.get(id)) return keywordsOf(products.get(id));
    const hits = await search(String(idOrQuery || ''), { limit: 5, internal: true });
    return { matches: hits.map(h => keywordsOf(products.get(h.product_id))) };
  }
  // The keyword picture across the catalog — "which products get searched the most", "keywords with 'book'".
  async function keywordTable(o) {
    await ready();
    o = o || {};
    const q = String(o.query || '').toLowerCase().trim();
    const rows = [];
    products.forEach(p => {
      ((p.seo && p.seo.keyword_analysis) || []).forEach(k => {
        if (!k || !k.keyword) return;
        if (q && String(k.keyword).toLowerCase().indexOf(q) < 0 && String(p.public_title || p.title).toLowerCase().indexOf(q) < 0) return;
        rows.push({ keyword: k.keyword, search_volume: Number(k.search_volume) || 0, difficulty: k.difficulty, product_id: p.product_id, product: p.public_title || p.title, url: p.url });
      });
    });
    rows.sort((a, b) => b.search_volume - a.search_volume);
    return { rows: rows.slice(0, o.limit || 40), total: rows.length, internal_only: 'Marketing research for the team. Never shown or quoted to customers.' };
  }

  async function searchArticles(query, limit) {
    await ready();
    const qs = uniq(words(query));
    if (!qs.length) return [];
    const W = { name: 5, kw: 4, body: 1 };
    const out = [];
    articles.forEach(a => {
      let score = 0; const hit = new Set();
      Object.keys(W).forEach(k => { const g = a._idx[k]; if (!g) return; qs.forEach(w => { if (g.set.has(w)) { score += W[k]; hit.add(w); } }); });
      if (!hit.size) return;
      score *= 0.5 + (hit.size / qs.length) / 2;
      out.push({ slug: a.slug, title: a.title, url: a.url, description: a.description ? String(a.description).slice(0, 240) : null,
        category: a.category && a.category.title || null, published_at: a.published_at || null, score: Math.round(score * 10) / 10 });
    });
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit || 5);
  }
  async function article(slug, o) {
    await ready();
    const a = articles.get(String(slug || '').trim());
    if (!a) return null;
    const max = (o && o.max) || 7000;
    const body = String(a.content || '');
    return { slug: a.slug, title: a.title, url: a.url, description: a.description || null, category: a.category && a.category.title || null,
      tags: a.tags || [], published_at: a.published_at || null, content: body.length > max ? body.slice(0, max) + '…' : body, truncated: body.length > max };
  }
  function status() {
    return { enabled: !OFF, base: BASE, products: products.size, articles: articles.size, last_refresh: lastRefresh, last_error: lastError, refreshing: refreshing, refresh_min: REFRESH_MIN };
  }

  return { ready, refresh, search, product, visibleTo, knowledgeFor, keywords, keywordTable, searchArticles, article, status, words };
};
