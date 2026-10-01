/**
 * Files customers attach in the client chat (Nova for clients).
 *
 * detect()  — what a file really is, from its first bytes (the name alone is
 *             not trusted) and its extension.
 * process() — what Nova can use from it:
 *               images        -> a JPEG preview the model can look at + size / dpi
 *               PDF           -> sent to the model as a document (short ones), or its text
 *               Illustrator   -> modern .ai files are PDF-compatible: read like a PDF
 *               Photoshop     -> the flattened image decoded here (no extra package) + size / dpi / colour mode
 *               EPS           -> noted only
 *               Excel / CSV / text / markdown -> the text
 *
 * Pure helpers: no Express, no database. client-bot.js stores the files and
 * decides who may use them.
 */
'use strict';

const MAX_BYTES = 25 * 1024 * 1024;
const MODEL_PDF_BYTES = 12 * 1024 * 1024;   // larger PDFs go to the model as text
const MODEL_PDF_PAGES = 20;
const PREVIEW_PX = 1568;                    // longest side the model reads well

const EXT = {
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', tif: 'image', tiff: 'image',
  pdf: 'pdf', ai: 'ai', eps: 'eps', psd: 'psd', psb: 'psd',
  xlsx: 'sheet', xlsm: 'sheet', xls: 'sheet', csv: 'text', tsv: 'text', txt: 'text', md: 'text', markdown: 'text'
};
const ACCEPT = Object.keys(EXT).map(e => '.' + e).join(',');

const extOf = (name) => (String(name || '').toLowerCase().match(/\.([a-z0-9]{1,9})$/) || [])[1] || '';
const starts = (buf, s, at) => buf.length >= (at || 0) + s.length && buf.toString('latin1', at || 0, (at || 0) + s.length) === s;

function detect(buf, name) {
  const ext = extOf(name);
  if (!buf || !buf.length) return { error: 'That file is empty.' };
  if (buf.length > MAX_BYTES) return { error: 'That file is over 25 MB.' };
  const b0 = buf[0], b1 = buf[1], b2 = buf[2];
  if (b0 === 0xFF && b1 === 0xD8 && b2 === 0xFF) return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' };
  if (starts(buf, '\x89PNG')) return { kind: 'image', mime: 'image/png', ext: 'png' };
  if (starts(buf, 'GIF8')) return { kind: 'image', mime: 'image/gif', ext: 'gif' };
  if (starts(buf, 'RIFF') && starts(buf, 'WEBP', 8)) return { kind: 'image', mime: 'image/webp', ext: 'webp' };
  if (starts(buf, 'II*\x00') || starts(buf, 'MM\x00*')) return { kind: 'image', mime: 'image/tiff', ext: 'tif' };
  if (starts(buf, 'ftyp', 4) && /^(heic|heix|hevc|mif1|msf1)$/.test(buf.toString('latin1', 8, 12))) {
    return { error: 'iPhone HEIC photos can’t be read here — please send it as a JPG or PNG (or a screenshot).' };
  }
  if (starts(buf, '%PDF')) return ext === 'ai' ? { kind: 'ai', mime: 'application/pdf', ext: 'ai', pdf: true }
                                               : { kind: 'pdf', mime: 'application/pdf', ext: 'pdf', pdf: true };
  if (starts(buf, '%!PS') || (b0 === 0xC5 && b1 === 0xD0 && b2 === 0xD3)) {
    return ext === 'ai' ? { kind: 'ai', mime: 'application/postscript', ext: 'ai' } : { kind: 'eps', mime: 'application/postscript', ext: 'eps' };
  }
  if (starts(buf, '8BPS') && buf.length >= 40) return { kind: 'psd', mime: 'image/vnd.adobe.photoshop', ext: buf.readUInt16BE(4) === 2 ? 'psb' : 'psd' };
  if (starts(buf, 'PK\x03\x04') && /^(xlsx|xlsm)$/.test(ext)) return { kind: 'sheet', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: ext };
  if (b0 === 0xD0 && b1 === 0xCF && b2 === 0x11 && ext === 'xls') return { kind: 'sheet', mime: 'application/vnd.ms-excel', ext: 'xls' };
  if (EXT[ext] === 'text') {
    const head = buf.slice(0, 600).toString('utf8');
    const ok = (head.match(/[\x09\x0a\x0d\x20-\x7e -￿]/g) || []).length;
    if (head.length && ok / head.length > 0.9) return { kind: 'text', mime: ext === 'md' || ext === 'markdown' ? 'text/markdown' : (ext === 'csv' ? 'text/csv' : 'text/plain'), ext: ext };
    return { error: 'That file could not be read as text.' };
  }
  return { error: 'That file type isn’t supported. Send JPG, PNG, PDF, AI, PSD, Excel, CSV or MD files.' };
}

// A spreadsheet is a zip. Read its directory first, so a small file that unpacks
// to gigabytes (a "zip bomb") is refused before anything is unpacked.
function zipTooBig(buf, limit) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
    const count = buf.readUInt16LE(i + 10);
    let at = buf.readUInt32LE(i + 16), total = 0;
    for (let n = 0; n < count && at + 46 <= buf.length; n++) {
      if (buf.readUInt32LE(at) !== 0x02014b50) return true;
      total += buf.readUInt32LE(at + 24);
      if (total > limit) return true;
      at += 46 + buf.readUInt16LE(at + 28) + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    }
    return false;
  }
  return true;                                           // not a readable zip
}

const inches = (px, dpi) => Math.round(px / dpi * 100) / 100;
const fmtSize = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

// ---------------------------------------------------------------- PDF / spreadsheets
// Read in a worker thread with a memory cap and a time limit (client-files-worker.js):
// a crafted file can only kill the worker. Resolves null when it fails.
function inWorker(job, ms) {
  return new Promise((resolve) => {
    let done = false, w;
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); try { w && w.terminate(); } catch (e) {} resolve(v); };
    const t = setTimeout(() => finish(null), ms || 20000);
    try {
      const { Worker } = require('worker_threads');
      w = new Worker(require('path').join(__dirname, 'client-files-worker.js'), {
        workerData: job, resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 48, stackSizeMb: 8 } });
      w.on('message', (m) => finish(m && m.ok ? m.result : null));
      w.on('error', () => finish(null));
      w.on('exit', () => finish(null));
    } catch (e) { finish(null); }
  });
}
const pdfFacts = (buf) => inWorker({ type: 'pdf', buf: buf }, 20000).then(r => r || {});
const pdfText = (buf) => inWorker({ type: 'pdf', buf: buf, text: true }, 25000).then(r => (r && r.text) || '');

// ---------------------------------------------------------------- Photoshop
// Reads the header, the resolution and the flattened ("composite") image that
// Photoshop stores at the end of every PSD, decoding only the rows and columns
// the preview needs. Falls back to the small embedded thumbnail.
function psdRead(buf) {
  const out = {};
  const psb = buf.readUInt16BE(4) === 2;
  out.channels = buf.readUInt16BE(12);
  out.height = buf.readUInt32BE(14);
  out.width = buf.readUInt32BE(18);
  out.depth = buf.readUInt16BE(22);
  out.mode = buf.readUInt16BE(24);
  let at = 26;
  at += 4 + buf.readUInt32BE(at);                       // colour mode data
  const resLen = buf.readUInt32BE(at); at += 4;
  const resEnd = at + resLen;
  while (at + 12 <= resEnd && starts(buf, '8BIM', at)) {
    const id = buf.readUInt16BE(at + 4);
    let p = at + 6;
    const nameLen = buf[p]; p += 1 + nameLen; if ((1 + nameLen) % 2) p++;
    const size = buf.readUInt32BE(p); p += 4;
    if (id === 0x03ED && size >= 16) {                 // ResolutionInfo
      out.dpi = Math.round(buf.readUInt32BE(p) / 65536);  // always pixels per inch (the unit is display only)
    }
    if ((id === 0x040C || id === 0x0409) && size > 28 && buf.readUInt32BE(p) === 1) out.thumb = buf.slice(p + 28, p + size);
    at = p + size + (size % 2);
  }
  at = resEnd;
  const lmLen = psb ? Number(buf.readBigUInt64BE(at)) : buf.readUInt32BE(at);
  at += (psb ? 8 : 4) + lmLen;
  out.dataAt = at;
  out.psb = psb;
  return out;
}

function unpackRow(buf, at, end, need) {
  const row = Buffer.alloc(need);
  let o = 0;
  while (at < end && o < need) {
    const n = buf.readInt8(at++);
    if (n >= 0) { buf.copy(row, o, at, Math.min(at + n + 1, end)); o += n + 1; at += n + 1; }
    else if (n !== -128) { row.fill(buf[at++], o, Math.min(o + 1 - n, need)); o += 1 - n; }
  }
  return row;
}

async function psdPreview(buf, sharp, h) {
  const used = h.mode === 1 || h.mode === 8 ? 1 : h.mode === 3 ? 3 : h.mode === 4 ? 4 : 0;
  if (!used || (h.depth !== 8 && h.depth !== 16) || h.channels < used || !h.width || !h.height) return null;
  const bps = h.depth / 8, rowBytes = h.width * bps;
  const k = Math.max(1, Math.ceil(Math.max(h.width, h.height) / PREVIEW_PX));
  const W = Math.ceil(h.width / k), H = Math.ceil(h.height / k);
  let at = h.dataAt;
  const comp = buf.readUInt16BE(at); at += 2;
  const rowAt = (c, y) => {                              // [start, end) of one stored row
    if (comp === 0) { const s = at + (c * h.height + y) * rowBytes; return [s, s + rowBytes]; }
    return null;
  };
  let offs = null;
  if (comp === 1) {
    const cw = h.psb ? 4 : 2, n = h.channels * h.height;
    offs = new Float64Array(n + 1);
    let p = at + n * cw;
    for (let i = 0; i < n; i++) { offs[i] = p; p += cw === 2 ? buf.readUInt16BE(at + i * cw) : buf.readUInt32BE(at + i * cw); }
    offs[n] = p;
    if (p > buf.length + 16) return null;
  } else if (comp !== 0) return null;
  const planes = [];
  for (let c = 0; c < used; c++) {
    const plane = Buffer.alloc(W * H);
    for (let y2 = 0; y2 < H; y2++) {
      const y = Math.min(y2 * k, h.height - 1);
      let row;
      if (comp === 0) { const r = rowAt(c, y); row = buf.slice(r[0], r[1]); }
      else { const i = c * h.height + y; row = unpackRow(buf, offs[i], offs[i + 1], rowBytes); }
      for (let x2 = 0; x2 < W; x2++) plane[y2 * W + x2] = row[Math.min(x2 * k, h.width - 1) * bps] || 0;
    }
    planes.push(plane);
  }
  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    let r, g, b;
    if (used === 1) r = g = b = planes[0][i];
    else if (used === 3) { r = planes[0][i]; g = planes[1][i]; b = planes[2][i]; }
    else {                                               // CMYK is stored inverted (255 = no ink)
      const K = planes[3][i] / 255;
      r = Math.round(planes[0][i] * K); g = Math.round(planes[1][i] * K); b = Math.round(planes[2][i] * K);
    }
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
  }
  return sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 82 }).toBuffer();
}

// ---------------------------------------------------------------- process
// -> { kind, mime, ext, label, info, preview (JPEG Buffer), send_pdf (bool), text }
async function processFile(buf, name, deps) {
  const d = detect(buf, name);
  if (d.error) return { ok: false, error: d.error };
  const sharp = deps.sharp;
  const out = { ok: true, kind: d.kind, mime: d.mime, ext: d.ext, size: buf.length, facts: [] };
  const facts = out.facts;
  try {
    if (d.kind === 'image') {
      out.label = 'Image';
      const img = sharp(buf, { limitInputPixels: 120e6, failOn: 'none' });
      const m = await img.metadata();
      facts.push(m.width + ' × ' + m.height + ' px');
      if (m.density && m.density > 72 && m.density < 4000) facts.push(m.density + ' dpi (' + inches(m.width, m.density) + '″ × ' + inches(m.height, m.density) + '″)');
      if (m.space === 'cmyk') facts.push('CMYK'); else if (m.space === 'b-w') facts.push('Grayscale');
      out.preview = await sharp(buf, { limitInputPixels: 120e6, failOn: 'none' }).rotate()
        .resize(PREVIEW_PX, PREVIEW_PX, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).toBuffer();
    } else if (d.kind === 'pdf' || (d.kind === 'ai' && d.pdf)) {
      out.label = d.kind === 'ai' ? 'Adobe Illustrator file (PDF-compatible)' : 'PDF';
      const f = await pdfFacts(buf);
      if (f.pages) facts.push(f.pages + (d.kind === 'ai' ? ' artboard' : ' page') + (f.pages === 1 ? '' : 's'));
      if (f.w_in) facts.push(f.w_in + '″ × ' + f.h_in + '″' + (f.pages > 1 ? ' (first)' : ''));
      // Only a PDF we could open and count goes to the model whole; anything else
      // as text. (A file the model refuses would break the conversation.)
      out.pages = f.pages || null;
      if (buf.length <= MODEL_PDF_BYTES && f.pages && f.pages <= MODEL_PDF_PAGES) out.send_pdf = true;
      else { out.text = await pdfText(buf); if (!out.text) facts.push('too large to preview'); }
    } else if (d.kind === 'ai') {
      out.label = 'Adobe Illustrator file (older format)';
      facts.push('Nova cannot preview it');
    } else if (d.kind === 'eps') {
      out.label = 'EPS file';
      facts.push('Nova cannot preview it');
    } else if (d.kind === 'psd') {
      out.label = 'Photoshop file';
      const h = psdRead(buf);
      facts.push(h.width + ' × ' + h.height + ' px');
      if (h.dpi) facts.push(h.dpi + ' dpi (' + inches(h.width, h.dpi) + '″ × ' + inches(h.height, h.dpi) + '″)');
      facts.push(({ 0: 'Bitmap', 1: 'Grayscale', 2: 'Indexed', 3: 'RGB', 4: 'CMYK', 7: 'Multichannel', 8: 'Duotone', 9: 'Lab' })[h.mode] || 'mode ' + h.mode);
      if (h.depth !== 8) facts.push(h.depth + '-bit');
      try { out.preview = await psdPreview(buf, sharp, h); } catch (e) { out.preview = null; }
      if (!out.preview && h.thumb) {
        try {
          out.preview = await sharp(h.thumb, { limitInputPixels: 40e6, failOn: 'none' })
            .resize(PREVIEW_PX, PREVIEW_PX, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
          facts.push('small preview only');
        } catch (e) {}
      }
      if (!out.preview) facts.push('Nova cannot preview it');
    } else {                                              // sheet / text
      if (d.kind === 'sheet' && d.ext !== 'xls' && zipTooBig(buf, 40 * 1024 * 1024)) return { ok: false, error: 'That spreadsheet is too large to read — please send it as CSV.' };
      out.label = d.kind === 'sheet' ? 'Spreadsheet' : (d.ext === 'md' || d.ext === 'markdown' ? 'Markdown' : d.ext.toUpperCase() + ' file');
      const r = d.kind === 'sheet'
        ? await inWorker({ type: 'sheet', buf: buf }, 20000).then(x => x ? { ok: true, text: x.text, truncated: x.truncated }
            : { ok: false, error: 'That spreadsheet could not be read — please send it as CSV.' })
        : await deps.extractText(buf, d.mime, name);
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'That file could not be read.' };
      out.text = r.text;
      if (r.truncated) facts.push('long — the first part is read');
    }
  } catch (e) {
    if (d.kind === 'image') return { ok: false, error: 'That image could not be opened.' };
    facts.push('could not be read');
  }
  facts.push(fmtSize(buf.length));
  out.info = out.label + ' — ' + facts.join(', ');
  return out;
}

module.exports = { detect, processFile, ACCEPT, MAX_BYTES, MODEL_PDF_PAGES, extOf, psdRead, psdPreview, fmtSize, zipTooBig, inWorker };
