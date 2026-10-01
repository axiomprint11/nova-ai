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
| `CUSTOMER_VERIFY_URL` | The website API's "who am I" for a customer token. Default `https://laravelapi.axiomprint.com/api/v1/customers/me`. |
| `CLIENT_CART_API` | The website cart API. Default `https://website.workroomapp.com/api/v1`. |
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
  window.NovaClientChat = Object.assign(window.NovaClientChat || {}, {
    testKey: 'PASTE_CLIENT_BOT_TEST_KEY',   // test mode — remove this line when going live
    tokenKey: 'axiom-print-app'             // where the website keeps the customer's login
  });
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
| `onCartChanged: () => {}` | Optional: called after Nova added something to the cart (the site's own listener already refreshes the count). |
| `position: 'left'` | Desktop button on the left. |
| `lift: false` | Phone: don't move the site's sticky bars up (then place them yourself). |
| `liftSelector: '.sticky-cart'` | Phone: also move these elements up, if the automatic check misses one. |
| `barTitle`, `barText` | Phone bar wording (default "Ask Nova" / "Prices, options, files & your orders"). |
| `zIndex: 999` | Stacking of the launcher (default 999 — under the site's own pop-ups). |

`NovaClientChatAPI.open()` opens the chat from any link or button on the site; `NovaClientChatAPI.refresh()` re-checks
the sticky bars after the page rearranges them.

## Recognising a signed-in customer

The website tells the chat who is signed in; Nova verifies it and loads the customer from `axiomprint_new.customer`.
Nothing the visitor types is ever taken as proof of identity.

### How it works on axiomprint.com (live)

The header script sets `tokenKey: 'axiom-print-app'` — where the website keeps the customer's login. That entry is the
site's saved state (JSON); the script finds the token inside it (`token`, `access_token`, `accessToken`, …) and posts
`{ type: 'nova-client:signin', customer_token }` to the chat when it opens, or `nova-client:signout` for a guest. It is
sent once, when the chat loads: log in or out, then refresh the page.

Nova checks the token on its server — never trusting it by itself:

```http
GET https://laravelapi.axiomprint.com/api/v1/customers/me      (CUSTOMER_VERIFY_URL; this is the default)
Authorization: Bearer <customer_token>
```

200 → signed in (`data.customer`); 401 → a guest. The email must match that customer in our database. The customer id
comes only from this answer. The token itself is never stored, logged or shown.

What a signed-in customer gets: greeted by first name ("Hi Gus! …", header "Signed in as …"); their own jobs
(`my_orders`, `order_status`: status from the latest production scan, shipped / pickup, options, quantity); their
contact person (`get_customer` → `manager` from the website account, else `customer.manager_id` in our database);
Add to Cart straight into their website cart. Guests get products, options and prices; anything that needs an account
gets the sign-in message (https://axiomprint.com/login, then refresh).

Signed-in customers see their **account discount** on every quote — the same rule the staff chats use (`discountFor`,
via quoteProduct's `client_id`): the regular price struck through and their price beside it. Nova never quotes the
percentage. The cart is sent the price before the discount (as the website's cart API expects); the website applies
the account pricing there.

### Option A — signed handoff (alternative)

The website's **server** signs the logged-in customer with the shared secret. Nothing secret reaches the browser.
The email must match that customer's email in our database, and each signed payload works once.

```php
$p = base64_encode(json_encode([
    'customer_id' => $customer->id, 'email' => $customer->email, 'name' => $customer->name,
    'ts' => time(), 'nonce' => bin2hex(random_bytes(16)),
]));
$sig = hash_hmac('sha256', $p, env('NOVA_CLIENT_SSO_SECRET'));   // same value as CLIENT_SSO_SECRET
```

Pass it as `window.NovaClientChat.signin = { payload: '…', sig: '…' }`.

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

## Add to Cart — straight into the website cart

Signed-in customers only. The item goes into the customer's **real axiomprint.com cart** through the website's cart API
(`CLIENT_CART_API`, default `https://website.workroomapp.com/api/v1`); the chat never leaves the page.

**From a quote:** Add to Cart on a quantity row → a **Job name** box (pre-filled with the product name; checkout needs
one) → **Add … to cart**. The click is the customer's yes. The row turns into "✓ In cart" and Nova shows "Added to your
cart" with **Upload artwork & check out**. A guest gets "Sign in to add this to your cart" (login link), or the product
page with everything selected.

**From the conversation:** the `add_to_cart` tool, only after Nova has read the order back with the price and the
customer said yes.

What Nova's server does (it never takes a price, customer id or option from the browser or the model as given):

1. Prices the item again (`priceCard`, public options only) — list price, as the product page.
2. `POST /cart/add-item` with `userId` (the verified customer), `productId`, `price`, `selectedOption` (variable title,
   underscores kept → chosen option title; `Quantity` as a string — the same names orders are saved with),
   `availableKeys`, `parentCategoryId` (`product.product_category_id`), `designType` / `proofOptions` ("Send the Files
   Later" / "YES (online PDF proof)", or "No File" / "No Proof" when `product.need_design = 0`), `customSize` +
   `selectedMetric: "Inch"` for custom sizes only, `customQuantity` for a quantity that is not a listed tier, and for
   versions `totalQuantity` + `versionObject: [{name, quantity}]`.
3. `404 "User does not exist"` → `POST /axiom-user` (email, names, `userId`, the account record), then add once more.
4. The newest item in the returned cart → `PUT /cart/update-item/<id>` `{ jobName, notes }` (add-item does not keep them).
5. The chat posts `{ type: 'nova-client:add-to-cart', id, item: { alreadyAdded: true } }` to the page; the website
   refreshes its cart count and answers `nova-client:cart-result`. (`window.NovaClientChat.onCartChanged` is an
   optional extra hook.)

The admin preview (**Try it** as a customer) never touches a real cart: it shows **what would be sent**.

**To confirm with the web team:** the `versionObject` entries for a versions item (sent as `{ name, quantity }`), and
`customQuantity` with versions. One real versions item from `GET /cart/my-cart?userId=<id>` settles it.

Not yet: editing or removing cart items (→ https://axiomprint.com/my-cart).

## Going live — checklist

1. Fill in **Training → What Nova knows** (hours, phone, shipping, pickup, artwork rules) and review the house rules.
2. Test in **Try it** as a few real customers, including asking for someone else's order.
3. Sign-in uses the website login (`tokenKey: 'axiom-print-app'` + `customers/me`); test it signed in and as a guest.
4. Add the header script to the website (and the sign-in / Add to Cart hooks).
5. Set `CLIENT_BOT_PUBLIC=1`, restart, and watch **Conversations**.
