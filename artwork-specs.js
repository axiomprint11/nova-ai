/**
 * A product's own artwork requirements — `product.safe`, `product.bleed`, `product.dpi` in axiomprint_new — put in
 * the words NovaAI says to a customer (website chat, phone) and to staff (CRM Chat).
 *
 * AxiomPrint convention (the website's product settings and the Artwork training document): safe area and bleed are
 * TOTALS across a dimension. safe 0.25 = keep important content 0.125 in inside EACH trim edge; bleed 0.25 = 0.125 in
 * of extra artwork past EACH trim edge (a 3.5 × 2 in card is set up at 3.75 × 2.25 in). Customers are always told the
 * per-edge figure. A product's own values override the general guide; 0 means none for that product.
 *
 *   const { artworkSpecs, artworkLine } = require('./artwork-specs');
 *   artworkSpecs({ safe: '0.25', bleed: '0.25', dpi: '300' })  -> { safe_area, bleed, resolution, note }
 *   artworkLine(...)                                           -> one sentence for a prompt
 */
const num = (v) => (v == null || v === '' || !isFinite(Number(v))) ? null : Number(v);
const inch = (v) => String(+Number(v).toFixed(4)) + ' in';

function artworkSpecs(p) {
  if (!p) return null;
  const safe = num(p.safe), bleed = num(p.bleed), dpi = num(p.dpi);
  if (safe == null && bleed == null && dpi == null) return null;
  const out = {};
  if (safe != null) {
    out.safe_area = safe === 0
      ? { total_in: 0, per_edge_in: 0, say: 'This product has no safe-area requirement set.' }
      : { total_in: safe, per_edge_in: +(safe / 2).toFixed(4),
          say: 'Keep important text and logos at least ' + inch(safe / 2) + ' inside each trim edge (' + inch(safe) + ' total across each dimension).' };
  }
  if (bleed != null) {
    out.bleed = bleed === 0
      ? { total_in: 0, per_edge_in: 0, say: 'No bleed for this product: set the artwork at the exact finished size.' }
      : { total_in: bleed, per_edge_in: +(bleed / 2).toFixed(4),
          say: 'Extend backgrounds and images ' + inch(bleed / 2) + ' past each trim edge, so the file is ' + inch(bleed) + ' wider and ' + inch(bleed) + ' taller than the finished size.' };
  }
  if (dpi != null) out.resolution = { dpi: dpi, say: 'Images at least ' + dpi + ' DPI at the finished printed size.' };
  out.note = 'From this product’s own settings — they override the general artwork guide. Always tell the customer the per-edge figure.';
  return out;
}
// "Artwork for Business Cards: safe area … · bleed … · 300 DPI" — for a prompt line or a page note.
function artworkLine(p) {
  const a = artworkSpecs(p);
  if (!a) return '';
  return [a.safe_area && ('safe area: ' + a.safe_area.say), a.bleed && ('bleed: ' + a.bleed.say), a.resolution && a.resolution.say].filter(Boolean).join(' ');
}

module.exports = { artworkSpecs, artworkLine };
