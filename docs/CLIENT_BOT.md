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
| No SQL / database tool. Five fixed tools only: `search_products`, `product_details`, `price_product`, `my_orders`, `order_status`. | `TOOLS` in client-bot.js |
| The customer id comes from the verified session. The order tools add `estimate_clientid = <session customer>` (and the linked invoice must be theirs and not void). The model cannot pass a customer id. | `ownOrdersSql()` |
| An order number that is not theirs returns "not on your account" — the same answer as one that does not exist. | `order_status` |
| Products: only active products listed for the `axiom_print` site; products reserved for specific customers (`available_for_customers`) only show to those customers. | `publicProductWhere()` |
| Visitor tokens are signed with their own key and carry `kind: 'client'`; the staff `auth` middleware rejects them, so they open no staff endpoint. | `CLIENT_KEY`, server.js `auth` |
| The conversation history the model sees is loaded from the server. A chat id only continues a conversation that belongs to the same visitor and the same customer. | `/api/client-bot/chat` |
| Limits: 25 messages / 10 min per visitor, 60 per address, 30 new sessions / 10 min per address, a daily cap on public messages (`CLIENT_BOT_DAILY_CAP`, default 3,000); messages capped at 2,000 characters. | `rateLimited()`, `overLimit()` |
| Prices use only the options customers can see on the website: hidden / internal fields and hidden choices are neither selectable nor shown; a choice that redirects to another product is re-checked. | `publicOptions()` |
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

## Add to Cart

Prices show as one quote per product and options — the options once, then **Qty · Price · Add to Cart** for each
quantity — in a "Your quote" pane on the right (from 860px wide; narrower, in the conversation).

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
    url: 'https://axiomprint.com/product/raised-spot-uv-cards-184?shareId=66f8…' } }
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
4. Add the iframe to the website.
5. Set `CLIENT_BOT_PUBLIC=1`, restart, and watch **Conversations**.
