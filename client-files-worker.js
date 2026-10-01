/**
 * Runs the heavy file readers (spreadsheets, PDFs) off the main thread for
 * client-files.js, with a memory cap and a time limit. A crafted spreadsheet
 * or PDF can then only kill this worker, never stall Nova.
 */
'use strict';
const { parentPort, workerData } = require('worker_threads');

async function run(job) {
  const buf = Buffer.from(job.buf);
  if (job.type === 'sheet') {
    const XLSX = require('xlsx');
    // sheetRows: only the first rows are read, however big the sheet is.
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true, sheetRows: 2000, cellHTML: false, cellFormula: false });
    let out = '';
    for (const name of wb.SheetNames.slice(0, 6)) {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false });
      const rows = csv.split('\n').filter(Boolean).length;
      out += (out ? '\n\n' : '') + '### Sheet ' + name + ' (' + rows + ' rows)\n' + csv;
      if (out.length > 60000) break;
    }
    const truncated = out.length > 60000;
    return { text: out.slice(0, 60000), truncated: truncated };
  }
  if (job.type === 'pdf') {
    const { PDFParse } = require('pdf-parse');
    const p = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const info = await p.getInfo({ parsePageInfo: true });
      const pg = (info.pages || [])[0];
      const res = { pages: info.total || null, w_in: pg ? Math.round(pg.width / 72 * 100) / 100 : null,
                    h_in: pg ? Math.round(pg.height / 72 * 100) / 100 : null };
      if (job.text) {
        const t = await p.getText({ first: 20 });
        res.text = String(t.text || '').slice(0, 20000);
      }
      return res;
    } finally { try { await p.destroy(); } catch (e) {} }
  }
  throw new Error('unknown job');
}

run(workerData).then(r => parentPort.postMessage({ ok: true, result: r }),
                     e => parentPort.postMessage({ ok: false, error: String(e && e.message || e) }));
