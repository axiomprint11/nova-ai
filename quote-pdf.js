/**
 * quote-pdf.js — a small PDF writer (no dependencies) for NovaAI's quotes: the price cards from a website chat
 * as a one-or-more-page letter-size PDF the customer can download or receive by email.
 *
 *   const { quotePdf } = require('./quote-pdf');
 *   const buf = quotePdf({ title, who, date, cards, footer })   // → Buffer
 *
 * cards[] are the chat's price cards: { product, specs: [{field, value, tag}], rows: [{quantity, price, each,
 * list_price, discount, ready, cart: {url}}], versions }. Text is Helvetica / Helvetica-Bold (built into every
 * PDF reader, nothing embedded); characters outside Latin-1 are replaced, links are real link annotations.
 */
'use strict';

const W = 612, H = 792, M = 48;                     // US letter, 2/3" margins
const COL = { ink: '0.11 0.11 0.16', soft: '0.42 0.42 0.52', line: '0.86 0.86 0.9', band: '0.96 0.96 0.98', indigo: '0.31 0.27 0.9', green: '0.03 0.37 0.27' };
// Helvetica widths (per 1000 em) for the characters that matter; everything else ~ 556.
const WID = { ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191, '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556, '`': 333, a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500, '{': 334, '|': 260, '}': 334, '~': 584 };
const width = (s, size, bold) => { let w = 0; for (const ch of String(s)) w += (WID[ch] || 556) * (bold ? 1.06 : 1); return w * size / 1000; };
const latin = (s) => String(s == null ? '' : s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/–|—/g, '-').replace(/×/g, 'x').replace(/•/g, '-').replace(/·/g, '-').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
const pdfStr = (s) => '(' + latin(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ')';
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function wrap(text, size, bold, maxW) {
  const out = []; let line = '';
  for (const word of latin(text).split(/\s+/)) {
    const t = line ? line + ' ' + word : word;
    if (width(t, size, bold) <= maxW || !line) line = t; else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out;
}

function quotePdf(opts) {
  const pages = []; let ops = [], links = [], y = 0;
  const newPage = () => { ops = []; links = []; pages.push({ ops, links }); y = H - M; };
  const need = (h) => { if (y - h < M + 30) newPage(); };
  const text = (s, x, yy, size, opt) => { opt = opt || {}; ops.push('BT /' + (opt.bold ? 'F2' : 'F1') + ' ' + size + ' Tf ' + (opt.color || COL.ink) + ' rg ' + x.toFixed(1) + ' ' + yy.toFixed(1) + ' Td ' + pdfStr(s) + ' Tj ET'); };
  const rightText = (s, xr, yy, size, opt) => text(s, xr - width(latin(s), size, opt && opt.bold), yy, size, opt);
  const line = (x1, y1, x2, y2, color) => ops.push((color || COL.line) + ' RG 0.6 w ' + x1.toFixed(1) + ' ' + y1.toFixed(1) + ' m ' + x2.toFixed(1) + ' ' + y2.toFixed(1) + ' l S');
  const rect = (x, yy, w, h, color) => ops.push(color + ' rg ' + x.toFixed(1) + ' ' + yy.toFixed(1) + ' re f'.replace(' re f', ' ' + w.toFixed(1) + ' ' + h.toFixed(1) + ' re f'));
  const para = (s, x, size, opt, maxW) => { const ls = wrap(s, size, opt && opt.bold, maxW || (W - 2 * M - (x - M))); for (const l of ls) { need(size + 4); text(l, x, y, size, opt); y -= size * 1.35; } };

  newPage();
  // Header band
  rect(M, y - 34, W - 2 * M, 44, COL.band);
  text('AxiomPrint', M + 12, y - 12, 15, { bold: true });
  text('Quote from NovaAI', M + 12, y - 27, 9.5, { color: COL.soft });
  rightText(opts.date || '', W - M - 12, y - 12, 9.5, { color: COL.soft });
  if (opts.who) rightText(opts.who, W - M - 12, y - 27, 9.5, { color: COL.soft });
  y -= 56;
  if (opts.title) { text(opts.title, M, y, 13, { bold: true }); y -= 22; }
  if (opts.intro) { para(opts.intro, M, 10, { color: COL.soft }); y -= 6; }

  (opts.cards || []).forEach((c, i) => {
    need(80);
    if (i) { y -= 6; line(M, y, W - M, y); y -= 16; }
    text(c.product || 'Quote', M, y, 12.5, { bold: true }); y -= 17;
    const specs = (c.specs || []).filter(s => !/^quantity$/i.test(s.field || ''));
    const chosen = specs.filter(s => s.tag !== 'default'), dflt = specs.filter(s => s.tag === 'default');
    const specLine = (s) => s.field + ': ' + s.value;
    if (chosen.length) para(chosen.map(specLine).join('   |   '), M, 9.5, {});
    if (dflt.length) para('Standard: ' + dflt.map(specLine).join(', '), M, 8.5, { color: COL.soft });
    if (c.versions && c.versions.length) para(c.versions.length + ' versions in one order: ' + c.versions.map(v => v.name + ' x ' + v.quantity).join(', '), M, 9, { color: COL.soft });
    y -= 4;
    // Qty / Price / Each / Ready / Order
    const cx = { qty: M, price: M + 110, each: M + 215, ready: M + 300, order: W - M };
    need(30);
    rect(M, y - 5, W - 2 * M, 16, COL.band);
    text('QTY', cx.qty + 6, y - 1, 8, { bold: true, color: COL.soft }); text('PRICE', cx.price, y - 1, 8, { bold: true, color: COL.soft }); text('EACH', cx.each, y - 1, 8, { bold: true, color: COL.soft }); text('READY', cx.ready, y - 1, 8, { bold: true, color: COL.soft }); rightText('ORDER', cx.order - 6, y - 1, 8, { bold: true, color: COL.soft });
    y -= 20;
    (c.rows || []).forEach(r => {
      need(20);
      text(Number(r.quantity || 0).toLocaleString('en-US'), cx.qty + 6, y, 10.5, { bold: true });
      if (r.discount && r.list_price > r.price) { text(money(r.list_price), cx.price, y, 8.5, { color: COL.soft }); line(cx.price, y + 3, cx.price + width(money(r.list_price), 8.5), y + 3, COL.soft); text(money(r.price), cx.price + width(money(r.list_price), 8.5) + 5, y, 10.5, { bold: true, color: COL.indigo }); }
      else text(money(r.price), cx.price, y, 10.5, { bold: true, color: COL.indigo });
      text(r.each != null ? money(r.each) : '', cx.each, y, 9.5, { color: COL.soft });
      text(r.ready ? latin(String(r.ready).replace(/^\w+day, /, '')) : '', cx.ready, y, 9.5, { color: COL.soft });
      const url = r.cart && r.cart.url;
      if (url) { const lbl = 'Order now'; const lx = cx.order - 6 - width(lbl, 9.5, true); text(lbl, lx, y, 9.5, { bold: true, color: COL.indigo }); line(lx, y - 2, cx.order - 6, y - 2, COL.indigo); links.push({ x: lx - 2, y: y - 4, w: cx.order - 6 - lx + 4, h: 13, url: url }); }
      y -= 17;
    });
    if ((c.rows || []).some(r => r.discount)) { text('Your account discount is applied.', M, y, 8.5, { color: COL.green }); y -= 14; }
  });

  y -= 8; need(40); line(M, y, W - M, y); y -= 16;
  para(opts.footer || 'Prices are estimates from NovaAI and are confirmed at checkout. Production time starts the business day after approval; shipping is extra.', M, 8.5, { color: COL.soft });

  // ---- write the file ----
  const objs = [];                                  // 1-based object bodies
  const add = (body) => { objs.push(body); return objs.length; };
  const fontN = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontB = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pagesId = objs.length + 1 + pages.length * 2 + pages.reduce((n, p) => n + p.links.length, 0);   // placed after all pages
  const pageIds = [];
  pages.forEach(p => {
    const stream = Buffer.from(p.ops.join('\n'), 'latin1');
    const content = add('<< /Length ' + stream.length + ' >>\nstream\n' + stream.toString('latin1') + '\nendstream');
    const annots = p.links.map(l => add('<< /Type /Annot /Subtype /Link /Rect [' + l.x.toFixed(1) + ' ' + l.y.toFixed(1) + ' ' + (l.x + l.w).toFixed(1) + ' ' + (l.y + l.h).toFixed(1) + '] /Border [0 0 0] /A << /S /URI /URI ' + pdfStr(l.url) + ' >> >>'));
    pageIds.push(add('<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 ' + W + ' ' + H + '] /Resources << /Font << /F1 ' + fontN + ' 0 R /F2 ' + fontB + ' 0 R >> >> /Contents ' + content + ' 0 R' + (annots.length ? ' /Annots [' + annots.map(a => a + ' 0 R').join(' ') + ']' : '') + ' >>'));
  });
  const realPages = add('<< /Type /Pages /Kids [' + pageIds.map(i => i + ' 0 R').join(' ') + '] /Count ' + pageIds.length + ' >>');
  if (realPages !== pagesId) throw new Error('pdf object order');
  const catalog = add('<< /Type /Catalog /Pages ' + realPages + ' 0 R >>');
  const info = add('<< /Producer (NovaAI) /Title ' + pdfStr(opts.title || 'AxiomPrint quote') + ' /CreationDate (D:' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z) >>');
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'; const offs = [];
  objs.forEach((b, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += (i + 1) + ' 0 obj\n' + b + '\nendobj\n'; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + catalog + ' 0 R /Info ' + info + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(out, 'latin1');
}

module.exports = { quotePdf };
