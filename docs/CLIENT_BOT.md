# Nova for clients — the customer-facing ChatBot

A second Nova, separate from the staff ChatBot, for customers on axiomprint.com.

- **Anyone** can ask about products, options and prices, and get an "Order now" link with the options preselected.
- **A signed-in customer** can also ask about **their own** orders and quotes: status from the latest
  production scan, shipped / ready-for-pickup, options, quantity, what they paid.
- Nobody can reach another customer's data.

Admin console: **https://nova.axiomprint.com/client-bot** (Admin → Client ChatBot). Tabs:
**Try it** (chat as an anonymous visitor or as any customer), **Conversations** (every conversation, with who it
was), **Training** (house rules, knowledge, greeting, hand-off contact, with version history), **Setup**.

Code: `client-bot.js` (server), `public/client-chat.js` (the chat), `public/client-bot.html` + `client-bot-admin.js`
(console), `public/client-chat.html` (the page the website embeds).

## How other customers' data stays out of reach

This is enforced in code; the prompt rules are a second layer.

| Guard | Where |
|---|---|
| No SQL / database tool. Fixed tools only: `search_products`, `product_details`, `price_product`, `get_template`, `estimate_installation`, `estimate_delivery`, `my_orders`, `order_status`. | `TOOLS` in client-bot.js |
| The customer id comes from the verified session. The order tools add `estimate_clientid = <session customer>` (and the linked invoice must be theirs and not void). The model cannot pass a customer id. | `ownOrdersSql()` |
| An order number that is not theirs returns "not on your account" — the same answer as one that does not exist. | `order_status` |
| Products: only active products listed for the `axiom_print` site; products reserved for specific customers (`available_for_customers`) only show to those customers. | `publicProductWhere()` |
| Visitor tokens are signed with their own key and carry `kind: 'client'`; the staff `auth` middleware rejects them, so they open no staff endpoint. | `CLIENT_KEY`, server.js `auth` |
| The conversation history the model sees is loaded from the server. A chat id only continues a conversation that belongs to the same visitor and the same customer. | `/api/client-bot/chat` |
| Limits: 25 messages / 10 min per visitor, 60 per address, 30 new sessions / 10 min per address, a daily cap on public messages (`CLIENT_BOT_DAILY_CAP`, default 3,000); messages capped at 2,000 characters. | `rateLimited()`, `overLimit()` |
| Prices use only the options customers can see on the website: hidden / internal fields and hidden choices are neither selectable nor shown; a choice that redirects to another product is re-checked. | `publicOptions()` |
| Attachments: checked by their first bytes (not the name), 25 MB each, 5 per message, 20 uploads / 10 min per visitor and 40 per address, 300 MB a day per sender and 2 GB in total. A file can only be attached by the visitor who uploaded it; visitors can never download files — only admins, from Conversations. Spreadsheets and PDFs are read in a separate worker with a memory and time limit. | `/api/client-bot/upload`, client-files.js |
| Edit on a quote reprices through the same public-options filter as the tool (30 / 10 min per visitor). | `/api/client-bot/reprice`, `priceCard()` |
| Every page load starts signed out; only a fresh sign-in from the website upgrades it, and visitor tokens last 2 hours. | client-chat.html |
| Until `CLIENT_BOT_PUBLIC=1`, only Nova admins can use it (preview). | `identify()` |

The fixed safety rules are shown read-only in the Training tab; the house rules and knowledge are editable and
cannot switch them off.

## Environment (`.env`)

| Variable | Meaning |
|---|---|
| `CLIENT_BOT_PUBLIC=1` | Open it to website visitors. Leave unset while testing — admins only. |
| `CLIENT_SSO_SECRET` | Shared secret for the signed sign-in handoff (option A). |
| `CUSTOMER_VERIFY_URL` | The website API's "who am I" endpoint for a customer token (option B). |
| `CLIENT_BOT_MODEL` | Optional model override (default: the light model used elsewhere). |
| `CLIENT_BOT_DAILY_CAP` | Most public messages per 24 hours (default 3000). |
| `CLIENT_BOT_REPRICE_DAILY_CAP` | Most quote edits per 24 hours (default 5000). |
| `CLIENT_BOT_UPLOAD_DIR` | Where attachments are kept (default `client-uploads/` next to server.js — not public). |
| `CLIENT_BOT_UPLOAD_MB_DAY` | Total attachment megabytes accepted per 24 hours (default 2048). |
| `CLIENT_BOT_UPLOAD_DAYS` | Days attachments are kept (default 90). Files never sent with a message go after a day. |

## Putting it on the website — the header script

Paste into the `<head>` of axiomprint.com (every page):

```html
<script>
  window.NovaClientChat = {
    testKey: 'PASTE_CLIENT_BOT_TEST_KEY'   // test mode — remove this line when going live
  };
</script>
<script src="https://nova.axiomprint.com/client-embed.js" defer></script>
```

It adds the chat launcher:

- **Desktop** — an **Ask Nova** button in the bottom-right corner; the chat opens as an 876 × 620 panel (chat on the
  left, "Your quote" on the right). Product suggestions list one per line: the best four, then **Show more products**
  (up to 12).
- **Phone** (under 700px) — a **full-width bar fixed to the bottom** of the screen ("Ask Nova · Chat ›"). Tap it and
  the chat opens full screen, sized to the visible area so the keyboard never covers the message box. Anything the
  site pins to the bottom of the screen (the sticky **Order Now / Add to Cart** bar, a cookie notice) is moved up above
  the bar automatically, and the page gets matching space at the end, so nothing is covered. Big overlays (menus,
  cart drawers) are left alone and open above the bar.

**Test mode** — with `CLIENT_BOT_PUBLIC=test` and `CLIENT_BOT_TEST_KEY=…` in Nova's `.env`, and the same key as
`testKey`: the button only appears in a browser that opened any page with **`?nova=test`** once (remembered;
`?nova=off` hides it again). Everyone else sees nothing, and the chat refuses sessions without the key. The key is
visible in the page source, so treat test mode as "hidden", not "secret" — the rate limits and daily cap still apply.
Test conversations show under Conversations as Website.

**Going live** — set `CLIENT_BOT_PUBLIC=1`, restart, and remove `testKey` from the snippet.

Optional settings in `window.NovaClientChat`:

| Setting | What it does |
|---|---|
| `signin: { payload, sig }` (or a function returning it) | Signed-in customer, option A below. |
| `customerToken: 'token'` (or a function) | Signed-in customer, option B below. If neither is given, the script looks for a customer token in the site's `localStorage` (`customer_token`, `access_token`, `token`, `auth_token`, or `tokenKey`). `customerToken: false` turns that off. |
| `addToCart: (item) => Promise` | Makes Add to Cart put the item in the site's own cart (see Add to Cart). |
| `position: 'left'` | Desktop button on the left. |
| `lift: false` | Phone: don't move the site's sticky bars up (then place them yourself). |
| `liftSelector: '.sticky-cart'` | Phone: also move these elements up, if the automatic check misses one. |
| `barTitle`, `barText` | Phone bar wording (default "Ask Nova" / "Prices, options, files & your orders"). |
| `zIndex: 999` | Stacking of the launcher (default 999 — under the site's own pop-ups). |

`NovaClientChatAPI.open()` opens the chat from any link or button on the site; `NovaClientChatAPI.refresh()` re-checks
the sticky bars after the page rearranges them.

## Recognising a signed-in customer

The website tells the chat who is signed in; Nova verifies it and loads the customer from `axiomprint_new.customer`.
Nothing the visitor types is ever taken as proof of identity. **One of the two options is enough.**

### Option A — signed handoff (recommended)

The website's **server** signs the logged-in customer with the shared secret. Nothing secret reaches the browser.
The email must match that customer's email in our database, and each signed payload works once.

```php
// Laravel, in the layout, when a customer is logged in
$p = base64_encode(json_encode([
    'customer_id' => $customer->id,      // must be customer.id in axiomprint_new
    'email'       => $customer->email,   // checked against that customer's email
    'name'        => $customer->name,
    'ts'          => time(),             // accepted for 10 minutes
    'nonce'       => bin2hex(random_bytes(16)),   // single use: a captured sign-in cannot be replayed
]));
$sig = hash_hmac('sha256', $p, env('NOVA_CLIENT_SSO_SECRET'));   // same value as CLIENT_SSO_SECRET
```

```html
<iframe id="novaClient" src="https://nova.axiomprint.com/client-chat"
        style="width:400px;height:600px;border:0" allow="clipboard-write"></iframe>
<script>
  window.addEventListener('message', function (ev) {
    if (ev.origin !== 'https://nova.axiomprint.com' || !ev.data) return;
    var frame = document.getElementById('novaClient').contentWindow;
    if (ev.data.type === 'nova-client:ready') {
      @if(auth('customer')->check())
        frame.postMessage({ type: 'nova-client:signin', payload: '{{ $p }}', sig: '{{ $sig }}' }, 'https://nova.axiomprint.com');
      @else
        frame.postMessage({ type: 'nova-client:signout' }, 'https://nova.axiomprint.com');
      @endif
    }
    if (ev.data.type === 'nova-client:close') { /* hide the chat panel */ }
  });
</script>
```

### Option B — customer API token

If the website keeps the customer's API token in the browser, post it instead:

```js
frame.postMessage({ type: 'nova-client:signin', customer_token: token }, 'https://nova.axiomprint.com');
```

Nova calls `CUSTOMER_VERIFY_URL` with `Authorization: Bearer <token>` and reads `email` (required) and
`customer_id` / `id` from the JSON (`data.customer`, `data.user`, `data`, `customer` or `user`). The email must
match the customer exactly; an id is only used together with a matching email.

Only `https://axiomprint.com` and `https://www.axiomprint.com` may send a sign-in to the chat page, and only those
sites may frame it.

## Templates, installation and delivery

- **Templates** — `get_template` finds a product's template / die line files (the same `die_line` records the
  staff chat uses), only on options customers can see, and never a die made for another customer
  (`die_line.customer_id`). Each comes with a **Download PDF** button. The file is streamed by Nova from Drive through
  a signed link (`/api/client-bot/template/:item/:customer/:sig/:name`), re-checked on every download, so the Drive
  files stay private.
- **Installation / local delivery** — `estimate_installation` and `estimate_delivery` use the same engine and the same
  admin-edited rates as the staff calculator (Admin → Installation Pricing), with the distance measured from the
  Glendale shop. The customer sees an **estimate** card: the total and what it covers (materials, crew, equipment,
  insurance, travel) — not our hourly or per-mile rates. Jobs the engine flags (too high, too far, crane) say our
  team will confirm or quote it.

## Attachments

The 📎 button, pasting (a screenshot straight from the clipboard) and drag & drop all attach files — up to 5 per
message: **JPG, PNG, GIF, WebP, TIFF, PDF, AI, EPS, PSD, Excel (xlsx / xls), CSV, TXT, MD**. Each file uploads as soon
as it is added; Send waits for any still uploading.

| File | What Nova gets |
|---|---|
| Images, screenshots | The picture (1568px), plus pixel size, dpi and print size |
| PDF | The PDF itself (up to 20 pages / 12 MB), otherwise its text; page count and page size |
| Illustrator (.ai) | Modern .ai files are PDF-compatible, so Nova reads them like a PDF; older ones are only noted |
| Photoshop (.psd) | The flattened image, decoded by Nova, plus size, dpi and colour mode (RGB / CMYK) |
| EPS | Noted only |
| Excel / CSV / TXT / MD | The text (first 2,000 rows of each sheet) |

Nova uses them to understand the request (sizes, quantities, a list of items to price) and may point out obvious
things (low resolution, RGB), but never approves artwork. Pictures and PDFs are re-shown to Nova for the latest two
messages that had them; older ones are described. If the model refuses a file, it is marked and the answer is
retried without it, so one bad file can't break the conversation. The team sees every attachment under
**Conversations** — Nova's preview and a **Download** of the original.

## Several designs: versions

Designs that share a size and options are priced as **one order with versions**, the way the website calculator does
it (Design 1: 100 + Design 2: 150 = one estimate of 250 with 2 versions) — `price_product` takes
`versions: [{name, quantity}]`. Designs in different sizes get one quote per size, each with its own versions. The
card lists the versions under the options; Edit changes each version's quantity. A product without versions is priced
as one run of the total, and Nova says so. Add to Cart passes the list as `item.versions` (the share link itself
carries the total quantity only).

## Quote cards: Specified / Default / Questionable, and Edit

Every option on a quote is tagged: **Specified** (the customer chose it), **Default** (the website default) or
**Questionable** (left on the default although it changes the price — the fields ticked "clarify for AI" on the
product, and the quantity when none was given). Questionable rows are highlighted, and Nova asks the customer to
confirm them in one short question.

**Edit** on the card turns the options into dropdowns (public options only, choices that fit the current selection)
and the quantities into a field. **Update price** prices it again on the server — no model call — and the new quote
replaces the old one. What changed is noted in the conversation (shown in Conversations), so Nova knows about it in
its next answer. Options the customer touched, or that were Specified or Questionable, become Specified.

## Add to Cart

Prices show as one quote per product and options — the options once, then **Qty · Price · Add to Cart** for each
quantity — in a "Your quote" pane on the right (from 800px wide; narrower, in the conversation).

The website owns its cart, so the chat asks the page that hosts it to add the item. Nova has no access to the
website cart itself.

1. When the chat loads it posts `{ type: 'nova-client:ready' }` to the page.
2. A page that can add to its cart answers `{ type: 'nova-client:cart-ready' }` (alongside the sign-in message).
3. On Add to Cart the chat posts:

```js
{ type: 'nova-client:add-to-cart', id: 'k3j9…', item: {
    product_id: 184, product: 'Raised Spot UV Business Cards', quantity: 500,
    price: 122.00,                                   // for display only — the website prices it itself
    share_id: '66f8a1c2e4b0a91d2c3f4e5a',            // the saved selection (product-shares API)
    config: { selections: { Shape: 10, Raised_Spot_UV: 21, Quantity: 93 }, selectedMetric: 'inch' },
    url: 'https://axiomprint.com/product/raised-spot-uv-cards-184?shareId=66f8…',
    versions: [{ name: 'Design 1', quantity: 200 }, { name: 'Design 2', quantity: 300 }] } }   // only for a versions quote
```

4. The page adds it with its own cart code (the same `selections` the product page applies from a share link) and
   answers `{ type: 'nova-client:cart-result', id: 'k3j9…', ok: true }`. The button turns into "✓ In cart".

If the page never said `cart-ready`, or does not answer within 6 seconds, the button opens the product page with
every option preselected (the share link), where the customer adds it to the cart themselves. The admin preview
always does this.

```js
// on the website page, next to the sign-in code
if (ev.data.type === 'nova-client:ready') frame.postMessage({ type: 'nova-client:cart-ready' }, 'https://nova.axiomprint.com');
if (ev.data.type === 'nova-client:add-to-cart') {
  addToCartFromSelections(ev.data.item)            // the website's own cart logic
    .then(() => frame.postMessage({ type: 'nova-client:cart-result', id: ev.data.id, ok: true }, 'https://nova.axiomprint.com'))
    .catch(() => frame.postMessage({ type: 'nova-client:cart-result', id: ev.data.id, ok: false }, 'https://nova.axiomprint.com'));
}
```

## Going live — checklist

1. Fill in **Training → What Nova knows** (hours, phone, shipping, pickup, artwork rules) and review the house rules.
2. Test in **Try it** as a few real customers, including asking for someone else's order.
3. Pick option A or B with the web team; set `CLIENT_SSO_SECRET` (A) or `CUSTOMER_VERIFY_URL` (B).
4. Add the header script to the website (and the sign-in / Add to Cart hooks).
5. Set `CLIENT_BOT_PUBLIC=1`, restart, and watch **Conversations**.
