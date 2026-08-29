/**
 * axiom-files.js — attachments for Nova chat.
 *
 * Images and PDFs go to the model as native blocks; spreadsheets, Word docs and
 * text files are extracted server-side into text the conversation can use.
 *
 * Shared by the ChatBot page and the CRM widget so the two cannot drift. Each
 * page supplies its own element ids and chip classes:
 *
 *   AxiomFiles.init({
 *     getToken: () => token,
 *     pendingEl: 'pendingBar',      // container for the chips
 *     chipClass: 'pf-chip',         // optional, for page-specific styling
 *   });
 *
 *   AxiomFiles.add(fileList)        // from an <input type=file> or drop
 *   AxiomFiles.paste(event)         // from a paste handler
 *   AxiomFiles.take()               // returns and CLEARS the pending list
 *   AxiomFiles.count()
 */
(function (global) {
  'use strict';

  var CFG = { getToken: function () { return null; }, pendingEl: 'pendingBar' };
  var pendingImages = [];

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // Named so it can't be confused with a value: 'Bearer ' + token would have
  // concatenated the function source and sent that as the credential.
  function authHeader() { return 'Bearer ' + (CFG.getToken() || ''); }


function renderPending() {
  const bar = document.getElementById(CFG.pendingEl);
  if (!bar) return;
  if (!pendingImages.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = 'flex';
  bar.innerHTML = pendingImages.map((im, i) => {
    if (im.kind === 'image' || (!im.kind && im.data)) {
      return '<span class="wg-thumb"><img src="data:' + im.media_type + ';base64,' + im.data + '" alt="">' +
        '<button type="button" data-rm="' + i + '" title="Remove">✕</button></span>';
    }
    const icon = im.kind === 'pdf' ? '📄' : im.kind === 'error' ? '⚠️' : im.kind === 'pending' ? '⏳' : '📎';
    return '<span class="wg-file' + (im.kind === 'error' ? ' err' : '') + '">' + icon +
      '<span class="wg-file-n">' + esc(im.name || 'file') + '</span>' +
      (im.note ? '<span class="wg-file-x">' + esc(im.note) + '</span>' : '') +
      '<button type="button" data-rm="' + i + '" title="Remove">✕</button></span>';
  }).join('');
  bar.querySelectorAll('[data-rm]').forEach(b => {
    b.onclick = () => { pendingImages.splice(Number(b.getAttribute('data-rm')), 1); renderPending(); };
  });
}

// Downscale before sending: a raw screenshot can be several MB, which is slow
// and wasteful when the model only needs to read it.
function fileToImageBlock(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read failed'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('decode failed'));
      img.onload = () => {
        const MAX = 1600;
        let w = img.width, h = img.height;
        if (w > MAX || h > MAX) {
          const r = Math.min(MAX / w, MAX / h);
          w = Math.round(w * r); h = Math.round(h * r);
        }
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        const url = cv.toDataURL('image/jpeg', 0.85);
        resolve({ media_type: 'image/jpeg', data: url.split(',')[1] });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}


function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('read failed'));
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.readAsDataURL(file);
  });
}

async function handlePastedFiles(files) {
  const list = Array.from(files || []).filter(Boolean).slice(0, 5);
  if (!list.length) return false;
  for (const f of list) {
    const name = (f.name || 'file').toLowerCase();
    if (f.size > 15 * 1024 * 1024) {
      pendingImages.push({ kind: 'error', name: f.name, note: 'too large (15MB max)' });
      continue;
    }
    try {
      if (/^image\//.test(f.type)) {
        const im = await fileToImageBlock(f);
        im.kind = 'image'; im.name = f.name;
        pendingImages.push(im);
      } else if (f.type === 'application/pdf' || name.endsWith('.pdf')) {
        pendingImages.push({ kind: 'pdf', name: f.name, media_type: 'application/pdf',
                             data: await readAsBase64(f) });
      } else {
        pendingImages.push({ kind: 'pending', name: f.name, note: 'reading…' });
        const idx = pendingImages.length - 1;
        renderPending();
        const r = await fetch('/api/chatbot/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': authHeader() },
          body: JSON.stringify({ data: await readAsBase64(f), mime: f.type, filename: f.name })
        });
        const j = await r.json();
        pendingImages[idx] = j.ok
          ? { kind: 'file', name: f.name, text: j.text, note: j.kind + (j.truncated ? ' · truncated' : '') }
          : { kind: 'error', name: f.name, note: j.error || 'could not read' };
      }
    } catch (e) {
      pendingImages.push({ kind: 'error', name: f.name, note: 'could not read' });
    }
  }
  renderPending();
  return true;
}

  global.AxiomFiles = {
    init: function (o) {
      o = o || {};
      if (o.getToken) CFG.getToken = o.getToken;
      if (o.pendingEl) CFG.pendingEl = o.pendingEl;
      if (o.chipClass) CFG.chipClass = o.chipClass;
    },
    add: function (files) { return handlePastedFiles(files); },
    paste: function (e) {
      var items = (e.clipboardData && e.clipboardData.items) || [];
      var files = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') { var f = items[i].getAsFile(); if (f) files.push(f); }
      }
      if (files.length) { e.preventDefault(); handlePastedFiles(files); return true; }
      return false;
    },
    // Hand the attachments to the caller and clear them — they belong to the
    // message being sent, not to the composer.
    take: function () {
      var out = pendingImages.slice();
      pendingImages = [];
      renderPending();
      return out;
    },
    count: function () { return pendingImages.length; },
    clear: function () { pendingImages = []; renderPending(); }
  };
})(window);
