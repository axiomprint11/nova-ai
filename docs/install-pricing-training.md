# Nova AI — Installation & Local Delivery Quoting

> Rates below are the DEFAULTS. Live rates are edited in Admin → Installation Pricing
> and applied by `public/install-pricing.js`, which the chat and the calculator card share.

Training reference for AxiomPrint's Nova assistant. Everything here mirrors the
Handling Options prototype, so a quote Nova gives in chat and a quote the job
ticket calculates land on the same number.

Sections: pricing rules → worked examples → how Nova should answer → JSON
contract → styling for rendered calculators.

---

## 1. Installation pricing

A quote is the sum of six parts. Any part that is zero is left off the answer.

### 1.1 Pieces

Each piece is priced twice: by area and by a fixed handling amount.

```
piece_sqft   = (width_in × height_in) / 144
piece_charge = piece_sqft × qty × sqft_rate + qty × fixed_fee
fixed_fee    = $20 per piece (default, editable per line)
```

`sqft_rate` comes from the material's level. The level is a default, not a law —
any line can be overridden.

| Level | Rate | Materials |
|---|---|---|
| Level 1 | $2 / sq ft | Vinyl decal (matte / gloss), rigid panel (foamcore, PVC), banner / canvas |
| Level 2 | $3 / sq ft | Perforated window film, frosted / etched film, floor graphic (laminated) |
| Level 3 | $5 / sq ft | Wall fabric / textured wall, ACM / aluminum panel, dimensional letters |

If the material is unknown, assume Level 1 and **say so in the answer**.

### 1.2 Crew size

Throughput first, then raised by the job's physical demands.

```
by_area   = 1 if total_sqft <= 200
            2 if total_sqft <= 800
            3 above that (cap 4)
crew      = by_area
crew      = max(crew, 2) if any equipment at height is needed
crew      = max(crew, 2) if any piece has a side >= 96" or is over 30 sq ft
```

The oversized-piece rule is about hands, not speed: a 140" panel needs two
people even if the whole job is 30 sq ft.

### 1.3 Hours on site

```
hours = 0.5                      # setup and staging
      + 0.25 × piece_count       # handling per piece
      + total_sqft / (100 × crew)  # 100 sq ft per installer per hour
      + rig_time                 # tallest equipment selected, not the sum
hours = round to nearest 0.5, minimum 1.0
```

Labor = `crew × hours × $35/hr` (installer rate, editable).

### 1.4 Equipment (multi-select, each with its own price)

| Item | Price | Rig time | Forces 2 installers |
|---|---|---|---|
| Ladder — up to 14 ft | $40 | 0.5 hr | yes |
| Tall ladder — 14 to 18 ft | $120 | 0.75 hr | yes |
| Crane / bucket lift — 18 to 35 ft | $450 | 1.5 hr | yes |
| Pre-install survey | $200 | — | no |

Nothing selected = ground level, no equipment charge. Above 35 ft, Nova does
not quote — route to a person.

### 1.5 Insurance

| Option | Charge |
|---|---|
| Waived | $0 |
| Liability, up to $100K | $75 |
| Extra insurance | from $250, editable |

Default to $75 unless the client says a certificate isn't needed. Many
buildings require the COI before the crew is let in.

### 1.6 Travel

```
travel = distance_miles × 2 × $2/mile        # billed round trip
```

Distance is driving distance from AxiomPrint, 4544 San Fernando Rd., Glendale,
CA 91204. In-shop installs ("At AxiomPrint") are 0 miles, no travel charge.

**Known gap:** installation bills mileage but not the crew's drive time. Past
roughly 100 miles the mileage alone stops covering the day — Nova should quote
the number and then flag that a travel-day or per-diem rate probably applies,
and hand off.

### 1.7 Scheduling surcharges

Driven by the installation date and the arrival window. Business hours are
**8:00 AM – 6:00 PM, Monday to Friday**.

| When | Labor | Call-out |
|---|---|---|
| Weekday inside business hours | 1× | — |
| Weekday outside business hours | 1.5× | $150 |
| Saturday | 1.5× | $150 |
| Sunday | 2× | $150 |

The multiplier applies to **labor only**. Pieces, equipment, insurance and
travel stay flat. The $150 is one call-out per job, not per installer.

### 1.8 Minimum

If the total lands under **$150**, top it up to $150.

### 1.9 Order of assembly

```
subtotal = labor (with multiplier) + fixed per piece + sq ft + travel
         + equipment + insurance + call-out
total    = max(subtotal, $150)
```

---

## 2. Local delivery pricing

Our own driver or Uber, inside the LA area.

```
mileage    = distance_miles × $2/mile        # one way
base_fee   = $10
drive_min  = (distance_miles / 22) × 60 × traffic_factor     # ~22 mph surface streets
time_charge= (drive_min × 2) / 60 × $25/hr   # billed both ways
total      = mileage + base_fee + time_charge
```

| Traffic at drop time | Factor |
|---|---|
| Off-peak (early or evening) | 1.0 |
| Midday | 1.3 |
| Peak (7–10 AM, 3–7 PM) | 1.9 |

Drive time is the point: a West Hollywood drop at 5 PM costs far more in hours
than in miles. If the client names a drop time, pick the factor from it. If
they don't, assume midday and say so.

### Distance zones (shown on every address)

| Zone | Distance | Color | Guidance |
|---|---|---|---|
| Zone 1 | under 10 mi | green | driver run, cheapest option |
| Zone 2 | 10–25 mi | yellow | driver still beats a carrier |
| Zone 3 | 25–50 mi | purple | compare driver against a carrier |
| Zone 4 | 50+ mi | grey | ship it; delivery is the wrong tool |

---

## 3. Worked examples (use these as few-shot training)

### A. Two decals, 3.5 miles, ladder — $290.43

Input: 36 × 28.17 vinyl decal ×1; 13 × 13 vinyl decal ×1; 2971 Partridge Ave
(3.5 mi); Friday 11:00–11:30 AM; 14 ft ladder; standard insurance.

| Line | Math | Amount |
|---|---|---|
| Graphics & materials | 8.22 sq ft @ $2 + 2 × $20 | $56.43 |
| Labor | 2 installers × 1.5 hrs × $35 | $105.00 |
| Ladder — up to 14 ft | | $40.00 |
| Insurance | | $75.00 |
| Travel | 7.0 mi round trip × $2 | $14.00 |
| **Total** | | **$290.43** |

Crew is 2 because the ladder needs a spotter; the ladder also adds 0.5 hr of
rig time, taking 1.0 hr to 1.5.

### B. Five panels, 200 miles — $1,408.58 (ground) / $1,483.58 (ladder)

Input: 31.75 × 140; 30.5 × 140; 35.75 × 97; 35.75 × 97; 69 × 43 — all vinyl,
qty 1 each. 200 miles. Weekday, business hours.

| Line | Ground | + 14 ft ladder |
|---|---|---|
| Graphics & materials (129.29 sq ft @ $2 + 5 × $20) | $358.58 | $358.58 |
| Labor | $175.00 (2 × 2.5 hrs) | $210.00 (2 × 3.0 hrs) |
| Equipment | — | $40.00 |
| Insurance | $75.00 | $75.00 |
| Travel (400 mi round trip) | $800.00 | $800.00 |
| **Total** | **$1,408.58** | **$1,483.58** |

Nova must add: travel is 57% of this job and the crew's ~7 hours of driving
aren't in the number — a 200-mile install should be quoted as a travel day.

### C. Local delivery, 9.5 miles to West Hollywood

| Traffic | Drive one way | Time charge | Total |
|---|---|---|---|
| Off-peak | 26 min | $21.67 | $50.67 |
| Midday | 34 min | $28.33 | $57.33 |
| Peak (5 PM) | 49 min | $40.83 | $69.83 |

Mileage and base are $29 in all three. Only time moves.

---

## 4. How Nova should answer

**Lead with the number.** "Roughly $290 for that install" before any table.

**Then the breakdown**, one line per part, in the order of §1.9.

**Then assumptions, briefly.** Every guess Nova made gets one line: material
level, insurance, traffic, business hours, distance source. A quote built on
three silent assumptions is worse than no quote.

**Ask at most one question**, and only when the answer changes the price by
more than ~15%. In order of impact: distance, piece sizes, height/access,
day and time. Never ask for something the job record already has.

**Round the spoken number, keep the math exact.** "About $290" in the sentence,
$290.43 in the table.

**Hand off, don't guess**, when: anything above 35 ft; installs past ~100 miles;
crane work; permits or union sites; a client disputing a quoted price; anything
where a wrong number goes on a signed contract.

**Never invent** a rate, a material level or a distance. If the material is
unknown say "assuming Level 1 at $2/sq ft".

### Response shape

> About **$290** for the Partridge Ave install.
>
> | Line | Amount |
> |---|---|
> | Graphics & materials — 2 pieces, 8.2 sq ft | $56.43 |
> | Labor — 2 installers × 1.5 hrs | $105.00 |
> | Ladder — up to 14 ft | $40.00 |
> | Insurance | $75.00 |
> | Travel — 7 mi round trip | $14.00 |
> | **Total** | **$290.43** |
>
> Assumes Level 1 vinyl, standard $75 liability, and a weekday inside business
> hours. Saturday would put it at about $493 (1.5× labor + $150 call-out).

---

## 5. Structured output (so the UI can render a calculator)

When the caller asks for a calculator rather than prose, Nova returns **only**
this JSON. The front end feeds it straight into the components in §6.

```json
{
  "kind": "installation",
  "currency": "USD",
  "inputs": {
    "address": "2971 Partridge Ave, Los Angeles, CA 90039",
    "distance_mi": 3.5,
    "zone": 1,
    "date": "2026-09-11",
    "arrival_start": "11:00 AM",
    "arrival_end": "11:30 AM",
    "schedule": "weekday_business",
    "crew": 2,
    "hours": 1.5,
    "equipment": ["h14"],
    "insurance": "std",
    "pieces": [
      {"name": "Version 1 — logo & quote decal", "w_in": 36, "h_in": 28.17,
       "qty": 1, "material": "vinyl", "sqft_rate": 2, "fixed_fee": 20,
       "sqft": 7.04, "amount": 34.09}
    ]
  },
  "lines": [
    {"label": "Graphics & materials · 2 pieces", "amount": 56.43},
    {"label": "Labor · 2 installers × 1.5 hrs × $35", "amount": 105.00},
    {"label": "Ladder — up to 14 ft", "amount": 40.00},
    {"label": "Insurance", "amount": 75.00},
    {"label": "Travel · 7.0 mi round trip × $2.00", "amount": 14.00}
  ],
  "total": 290.43,
  "assumptions": [
    "Level 1 vinyl at $2/sq ft",
    "Standard $75 liability insurance",
    "Weekday inside business hours — no surcharge"
  ],
  "warnings": []
}
```

Delivery uses the same envelope with `"kind": "delivery"` and lines for
mileage, base fee and drive time, plus `"traffic": "peak"` in inputs.

Rules: amounts are numbers, not strings, rounded to cents. `assumptions` is
never empty unless every input was given. `warnings` carries the hand-off
reasons from §4 — a non-empty `warnings` means the UI shows the quote as
provisional.

---

## 6. Styling — matching the job-ticket UI

Drop this into any Nova surface that renders a quote. It's the same token set
and the same components as the Handling Options prototype, so a calculator
rendered by Nova is indistinguishable from one in the job ticket.

### 6.1 Tokens

```css
:root{
  color-scheme: light;
  --bg:#ffffff; --surface:#ffffff; --surface-2:#f6f6fe;
  --border:#e6e6f7; --border-strong:#c9c9ee;
  --text:#191934; --muted:#56568a; --faint:#7676a8;
  --accent:#4f46e5; --accent-ink:#3730a3; --accent-soft:#eef2ff; --accent-line:#c7d2fe;
  --warn-bg:#fff8e8; --warn-line:#f2c14e; --warn-ink:#7a4d05;
  --bad-bg:#fef2f2; --bad-line:#f5a3a3; --bad-ink:#9a1c1c;
  --good-bg:#eefaf3; --good-ink:#146c43;
}
body{font-family:'DM Sans',system-ui,-apple-system,'Segoe UI',sans-serif;
  background:var(--bg); color:var(--text); font-size:15px; line-height:1.45;}
```

Font: DM Sans, weights 400 / 500 / 600 / 700, from
`https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap`.

### 6.2 Components

```css
/* card — the container for a whole quote */
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;
  padding:20px 22px;display:flex;flex-direction:column;gap:16px;
  box-shadow:0 1px 2px rgba(79,70,229,.05)}
.card-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
h2{margin:0;font-size:17px;font-weight:700;letter-spacing:-0.01em}
.hint{font-size:13px;color:var(--muted)}
.eyebrow{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}

/* nested panel — calculators sit inside this */
.calc{display:flex;flex-direction:column;gap:12px;padding:16px;
  background:var(--surface-2);border:1px solid var(--border);border-radius:12px}

/* breakdown lines + total */
.lines{display:flex;flex-direction:column;gap:10px}
.line{display:flex;justify-content:space-between;font-size:14px;color:var(--muted)}
.line b{color:var(--text)}
.total{display:flex;justify-content:space-between;align-items:baseline;
  padding-top:12px;border-top:1px solid var(--border)}
.total b{font-size:22px}
.calc-total{font-size:22px;font-weight:700}

/* fields */
.f{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:600;color:var(--muted)}
.f input,.f select{height:44px;padding:0 12px;border:1px solid var(--border-strong);
  border-radius:8px;background-color:var(--surface);color:var(--text);
  font-size:14px;font-weight:500;width:100%}
.f select{appearance:none;padding-right:38px;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%234f46e5' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'/></svg>");
  background-repeat:no-repeat;background-position:right 12px center}
.money{display:flex;align-items:center;height:44px;border:1px solid var(--border-strong);
  border-radius:8px;overflow:hidden;background:var(--surface)}
.money span{padding:0 10px;color:var(--muted);font-weight:600}
.money input{flex:1;min-width:0;height:100%;border:none;background:transparent;padding:0}
.readfield{display:flex;align-items:center;height:44px;padding:0 12px;border:1px solid var(--border);
  border-radius:8px;background:var(--surface-2);font-size:14px;font-weight:600;color:var(--muted)}

/* buttons */
.btn{height:44px;padding:0 16px;border:1px solid var(--border-strong);background:var(--surface);
  color:var(--text);border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
.btn.primary{border-color:var(--accent);background:var(--accent);color:#fff}

/* chips — statuses and zones */
.chip{display:inline-flex;align-items:center;gap:8px;height:30px;padding:0 14px;border-radius:999px;
  font-size:13px;font-weight:700;border:1px solid transparent}
.chip .bullet{width:9px;height:9px;border-radius:50%;background:currentColor}
.tone-grey{background:#f1f1f7;color:#55556f;border-color:#dedeed}
.tone-amber{background:#fff6e5;color:#8a5a00;border-color:#f3d79b}
.tone-indigo{background:#eef2ff;color:#3730a3;border-color:#c7d2fe}
.tone-purple{background:#f4ecfe;color:#6b21a8;border-color:#ddc6f7}
.tone-green{background:#e9f8f0;color:#146c43;border-color:#b6e6cd}

/* note — assumptions and warnings */
.note{display:flex;align-items:center;gap:14px;padding:12px 14px;background:var(--surface-2);
  border:1px solid var(--border);border-radius:10px;font-size:13px;color:var(--muted);flex-wrap:wrap}
.note.info{background:var(--accent-soft);border-color:var(--accent-line);color:var(--accent-ink)}
.note.warn{background:var(--warn-bg);border-color:var(--warn-line);color:var(--warn-ink)}
.note.bad{background:var(--bad-bg);border-color:var(--bad-line);color:var(--bad-ink);font-weight:600}

/* "?" tooltip — explanations live here, never inline */
.tip{position:relative;display:inline-flex}
.qmark{width:20px;height:20px;border-radius:50%;border:1px solid var(--accent);color:var(--accent-ink);
  background:var(--accent-soft);display:flex;align-items:center;justify-content:center;
  font-size:12px;font-weight:700;cursor:help}
.tip .bubble{position:absolute;top:calc(100% + 10px);left:50%;transform:translateX(-50%);width:280px;
  padding:12px 14px;background:#20204a;color:#f3f3ff;border-radius:10px;font-size:12.5px;
  line-height:1.5;opacity:0;visibility:hidden;transition:opacity .12s;z-index:60;
  box-shadow:0 14px 30px rgba(25,25,52,.28)}
.tip .bubble::after{content:"";position:absolute;bottom:100%;left:50%;transform:translateX(-50%);
  border:6px solid transparent;border-bottom-color:#20204a}
.tip:hover .bubble,.tip:focus-within .bubble{opacity:1;visibility:visible}
```

### 6.3 Markup pattern for a rendered quote

```html
<div class="card">
  <div class="card-head">
    <h2>Installation estimate</h2>
    <span class="chip tone-green"><span class="bullet"></span>3.5 mi</span>
  </div>

  <div class="calc">
    <div class="lines">
      <div class="line"><span>Graphics &amp; materials · 2 pieces</span><b>$56.43</b></div>
      <div class="line"><span>Labor · 2 installers × 1.5 hrs × $35</span><b>$105.00</b></div>
      <div class="line"><span>Ladder — up to 14 ft</span><b>$40.00</b></div>
      <div class="line"><span>Insurance</span><b>$75.00</b></div>
      <div class="line"><span>Travel · 7.0 mi round trip × $2.00</span><b>$14.00</b></div>
    </div>
    <div class="total"><b>Total</b><b>$290.43</b></div>
  </div>

  <div class="note info">
    Assumes Level 1 vinyl, $75 liability, weekday inside business hours.
    <span class="tip" tabindex="0"><span class="qmark">?</span>
      <span class="bubble">100 sq ft per installer per hour · 1 installer to 200 sq ft ·
      2 to 800 · 3 above. $150 minimum · weekend or after-hours $150 call-out at
      1.5× labor · Sunday 2× · mileage bills both ways.</span></span>
  </div>
</div>
```

### 6.4 Interface rules learned the hard way

- Explanations go in a `?` tooltip, never as body text. The panel shows numbers; the tooltip shows why.
- Tooltips open **below** the icon — above gets clipped by the card.
- Fixed widths on dropdowns, so switching options doesn't shift the row.
- Status color carries meaning: grey not started, amber waiting/ready, indigo in progress, green done.
- Declare `color-scheme: light` or the browser renders inputs dark and the text disappears.
- Amounts right-aligned in bold, labels left in muted — never the reverse.

---

## 7. Reference implementation

Portable JS, matching the prototype exactly. Use it as the source of truth when
wiring Nova to a real calculator rather than reasoning the arithmetic in prose.

```js
const RATES = { vinyl:2, rigid:2, banner:2, perf:3, frost:3, floor:3, wallfab:5, acm:5, letters:5 };
const EQUIP = {
  h14:    { fee:40,  hrs:0.5,  crew2:true },
  h18:    { fee:120, hrs:0.75, crew2:true },
  h35:    { fee:450, hrs:1.5,  crew2:true },
  survey: { fee:200, hrs:0,    crew2:false }
};
const HOURLY = 35, FIXED = 20, MILE = 2, MIN_CHARGE = 150;
const AFTER_HOURS_FEE = 150, SAT_MULT = 1.5, SUN_MULT = 2;

function crewForArea(sqft){
  if (sqft <= 200) return 1;
  if (sqft <= 800) return 2;
  return Math.min(4, 3 + Math.floor(Math.max(0, sqft - 1600) / 800));
}

function quoteInstall({ pieces, miles = 0, equipment = [], insurance = 75, schedule = 'weekday' }){
  let sqft = 0, sqftChg = 0, fixed = 0, count = 0, maxSide = 0, biggest = 0;
  for (const p of pieces){
    const each = (p.w * p.h) / 144, q = p.qty || 1;
    sqft += each * q;
    sqftChg += each * q * (p.rate ?? RATES[p.material] ?? 2);
    fixed += q * (p.fixed ?? FIXED);
    count += q;
    maxSide = Math.max(maxSide, p.w, p.h);
    biggest = Math.max(biggest, each);
  }

  let equipFee = 0, rig = 0, needsTwo = false;
  for (const id of equipment){
    const e = EQUIP[id]; if (!e) continue;
    equipFee += e.fee; rig = Math.max(rig, e.hrs); needsTwo = needsTwo || e.crew2;
  }

  let crew = crewForArea(sqft);
  if (needsTwo) crew = Math.max(crew, 2);
  if (maxSide >= 96 || biggest >= 30) crew = Math.max(crew, 2);

  let hours = 0.5 + 0.25 * count + sqft / (100 * crew) + rig;
  hours = Math.max(1, Math.round(hours * 2) / 2);

  const mult = schedule === 'sunday' ? SUN_MULT
             : (schedule === 'saturday' || schedule === 'afterhours') ? SAT_MULT : 1;
  const flat = mult > 1 ? AFTER_HOURS_FEE : 0;

  const labor  = crew * hours * HOURLY * mult;
  const travel = miles * 2 * MILE;
  const subtotal = labor + fixed + sqftChg + travel + equipFee + insurance + flat;

  return { crew, hours, sqft, sqftChg, fixed, labor, equipFee, insurance,
           travel, flat, total: Math.max(subtotal, MIN_CHARGE) };
}

const TRAFFIC = { off:1, mid:1.3, peak:1.9 };

function quoteDelivery({ miles, traffic = 'mid', driverRate = 25, base = 10, mileRate = 2, minsOverride = null }){
  const oneWay = minsOverride ?? Math.round((miles / 22) * 60 * TRAFFIC[traffic]);
  const timeChg = (oneWay * 2) / 60 * driverRate;
  return { oneWay, mileage: miles * mileRate, base, timeChg,
           total: miles * mileRate + base + timeChg };
}
```

---

## 8. Current gaps — tell the user, don't paper over them

1. **Installation drive time isn't billed.** Delivery charges the driver's hours; installation only charges mileage. Past ~100 miles this under-quotes badly.
2. **Crane pricing is a placeholder.** $450 flat. Cranes usually carry a day or half-day rate with a delivery window.
3. **Distances are manual.** Live build should pull driving distance, and for delivery traffic-aware duration, from Google Distance Matrix with `departure_time` set.
4. **No per-diem, lodging or permit line** anywhere in the model.
5. **Third-party carrier billing** (client's UPS/FedEx account) replaces the shipping line with a $15 handling fee — that path has no markup, so don't quote freight on it.
