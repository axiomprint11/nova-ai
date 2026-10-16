# Nova AI: guest cart

How Nova should add, remove and update cart items for customers who are **not signed in** on axiomprint.com.

## Why this is needed

- **Signed in:** works today. Nova's server adds the item to the customer's cart. The chat posts `nova-client:add-to-cart` with `{ alreadyAdded: true }`, and the site reloads the cart.
- **Guest:** the cart lives only in the customer's browser (IndexedDB). Nova's server can't reach it. Today `/api/client-bot/cart` returns `preview: true` with `would_send`, and the chat stops there. **Nothing reaches the cart.**

For guests, the chat has to hand the item to the page, and the page saves it. When the guest signs in later, the site moves those items into their server cart automatically.

## What the site provides

The site registers these functions on `window.NovaClientChat` as soon as the app loads, before the chat iframe opens.

| Function | Guest | Signed in |
| --- | --- | --- |
| `addToCart(item)` | Saves `item` to the browser cart | Reloads the cart (Nova's server already added it) |
| `getCart()` | Returns the cart lines (see below) | Returns `null`. Read the cart from your server |
| `removeFromCart(lineId)` | Removes that line | Throws. Use your server |
| `updateCartItem(lineId, changes)` | Updates that line and returns it | Throws. Use your server |
| `onCartChanged()` | Does nothing | Reloads the cart |

All of them are async. **On failure they throw an `Error` with a short message you can show to the customer.** `addToCart` returns `true` on success, so the embed's existing `r !== false` check keeps working.

## 1. Add (works with the current embed)

`client-embed.js` already passes `nova-client:add-to-cart` to `NovaClientChat.addToCart(d.item)` and replies `nova-client:cart-result { id, ok }`. It also posts `nova-client:cart-ready` when the hook exists.

**Changes needed in the chat (`client-chat`):**

1. Remember whether `nova-client:cart-ready` was received.
2. When `/api/client-bot/cart` returns a guest result (today: `preview: true`) and the cart is ready:
   ```js
   const id = Math.random().toString(36).slice(2);
   parentSay({ type: 'nova-client:add-to-cart', id, item: { ...j.would_send, nova_request_id: id } });
   ```
3. Wait for `nova-client:cart-result` with the same `id`.
   - `ok: true`: show "✓ In cart" and run the normal `onCartAdded` / `continueAfterCart` steps.
   - `ok: false`: show "That could not be added", plus the product-page link.
   - **Don't show "Preview ✓" for guests any more.**
4. Leave signed-in customers exactly as they are now.

**`nova_request_id` must be inside `item`.** The embed passes only `d.item` to `addToCart`, and the site uses this id to ignore duplicates if the message is sent twice.

### Item shape

This is a real, tested item for product 187 (Adhesive Vinyl). Send exactly this structure:

```json
{
  "nova_request_id": "k3j9x2a",
  "product_id": 187,
  "price": 42.5,
  "selectedOption": {
    "Shape":       { "id": 20499, "title": "Rectangle", "value": 0, "base": null, "mass": 0, "thick": 0, "type": "shape_list", "parent_order": 0, "swap": null, "calculation": 0, "configs": null },
    "Size":        { "id": 879, "title": "18 x 24", "value": 432, "base": 0, "mass": null, "thick": null, "type": "size_new", "parent_order": 1, "swap": "true", "calculation": 0,
                     "configs": { "defaultHeight": 36, "defaultWidth": 24, "maxHeight": 240, "maxWidth": 58, "metric": "inch", "isMetricEnabled": true, "minWidth": 1, "minHeight": 1, "wxh": true } },
    "Material":    { "id": 886, "title": "4 Mil. Permanent Adhesive", "value": 2, "mass": 0, "thick": 0, "type": "material_list", "parent_order": 2, "swap": null, "calculation": 0, "configs": null },
    "Print_Sides": { "id": 9723, "title": "Front Only", "value": 0, "mass": 0, "thick": 0, "type": "list", "parent_order": 3, "swap": null, "calculation": 0, "configs": null },
    "Print_Color": { "id": 13426, "title": "4/0 (Full Color, Front Only)", "value": 0, "mass": 0, "thick": 0, "type": "list", "parent_order": 4, "swap": null, "calculation": 0, "configs": null },
    "Lamination":  { "id": 887, "title": "Matte Lamination", "value": 1, "mass": 0, "thick": 0, "type": "list", "parent_order": 5, "swap": null, "calculation": 0, "configs": null },
    "Quantity":    { "id": 890, "title": "1", "value": 1, "mass": 0, "thick": 0, "type": "quantity_list", "parent_order": 6, "swap": null, "calculation": 0, "configs": null },
    "Turnaround":  { "id": 900, "title": "2 Business Days", "value": 1.05, "dayCount": 2, "mass": 0, "thick": 0, "type": "turnaround", "parent_order": 7, "swap": null, "calculation": 0, "configs": null }
  },
  "selectedMetric": "inch",
  "jobName": "Spring flyers"
}
```

### Fields

| Field | Required | Notes |
| --- | --- | --- |
| `nova_request_id` | Yes | Unique per add. The same id sent twice is added once. |
| `product_id` | Yes | `productId` is also accepted. |
| `price` | Yes | 0 or more. **Must come from Nova's server pricing, never from the AI's text.** |
| `selectedOption` | Yes | One entry per product option. See below. |
| `selectedMetric` | No | `"inch"` unless the product uses another unit. |
| `jobName` | No | The job name the customer typed. |
| `customSize` | No | `{ width, height, depth }`, only when `Size.title` is `"Custom Size"`. |
| `versionObject` | No | Only for multi-version orders; defaults to `[]`. |
| `totalQuantity` | No | Only with versions; defaults to `0`. |
| `notes`, `artNotes` | No | Free text. |

**Leave these out; the site fills them in:**

- **`product`:** the site loads the full product from `GET /api/v1/customers/products/{product_id}`, because the cart pages need all of its `variables`. If the product can't be loaded, the item is rejected.
- **`product_category_id`, `availableKeys`, `designType`, `proofOptions`, sample fees:** taken from that product.

### `selectedOption`

- **Key:** the variable's `title`, exactly as written (`Print_Sides`, `Print_Color`, …).
- **One entry for every variable of the product,** including hidden ones such as `Print_Color`. Pricing and shipping formulas use them.

Each entry must be a full object, never a plain string:

| Option field | Where it comes from |
| --- | --- |
| `id`, `title`, `value`, `base`, `mass`, `thick`, `dayCount` | The chosen item in `variable.items` |
| `type` | `variable.type` |
| `configs` | `variable.configs` |
| `parent_order` | `variable.order` |
| `swap` | `"true"` when `variable.configs.wxh` is set, else `null` |
| `calculation` | The variable itself when it's hidden, else `0` |

- **Other item fields:** sending the whole chosen item is fine. Leave out `filters`, `material`, `departments`, `geoSubType`, `geoType` and `used_in_products`.
- **`text` / `number` variables:** send the variable itself, plus `value`.

This matches how the product page builds the cart item (`hooks/useProductVariable.js`).

### When the site rejects an item

The site replies `cart-result` with `ok: false` when:

- `product_id` is missing, or `price` is missing or negative.
- any `selectedOption` entry is not an object, e.g. `"Quantity": "500"`. The cart, shipping and order code read `Size.title`, `Quantity.value`, `.mass`, `.thick`, … and would crash.
- `Size` has no `title`.
- there's no `Quantity`, `Total_Quantity` or `Roll_Count` with a value above 0.
- the product can't be loaded.

For the option and field checks, the exact reason is printed in the browser console as `Nova addToCart rejected item`.

### Test it in the browser

Log out, open the site and paste this in the console. It should return `true` and show the item in the cart.

```js
await window.NovaClientChat.addToCart({ /* the JSON above */ });
```

## 2. Read the guest cart (new)

The AI needs to see the guest's cart to answer "what's in my cart?" and to choose which line to remove.

**New message pair:**

- Chat → page: `{ type: 'nova-client:cart-get', id }`
- Page → chat: `{ type: 'nova-client:cart-list', id, ok, lines, error? }`

**Embed handler to add:**

```js
if (d.type === 'nova-client:cart-get' && typeof CFG.getCart === 'function') {
  Promise.resolve().then(function () { return CFG.getCart(); })
    .then(function (lines) { say({ type: 'nova-client:cart-list', id: d.id, ok: true, lines: lines }); },
          function (e) { say({ type: 'nova-client:cart-list', id: d.id, ok: false, error: e && e.message }); });
}
```

`lines` is `null` for signed-in customers. For guests it's an array:

```json
[
  {
    "line_id": 14,
    "product_id": 123,
    "title": "Business Cards",
    "price": 54.25,
    "options": { "Quantity": "500", "Paper": "16pt Matte" },
    "total_quantity": 0,
    "versions": [],
    "job_name": "Spring flyers",
    "notes": "",
    "art_notes": "",
    "source": "nova"
  }
]
```

**Before each guest message,** ask the page for the cart and send the lines to Nova's server with the message (for example through `extraBody`), so the AI works from the current cart.

## 3. Remove and update (new)

**New messages:**

- Chat → page: `{ type: 'nova-client:cart-remove', id, lineId }`
- Chat → page: `{ type: 'nova-client:cart-update', id, lineId, changes }`
- Page → chat (both): `{ type: 'nova-client:cart-result', id, ok, line?, error? }`

**Embed handlers to add:**

```js
if (d.type === 'nova-client:cart-remove' && typeof CFG.removeFromCart === 'function') {
  Promise.resolve().then(function () { return CFG.removeFromCart(d.lineId); })
    .then(function () { say({ type: 'nova-client:cart-result', id: d.id, ok: true }); },
          function (e) { say({ type: 'nova-client:cart-result', id: d.id, ok: false, error: e && e.message }); });
}
if (d.type === 'nova-client:cart-update' && typeof CFG.updateCartItem === 'function') {
  Promise.resolve().then(function () { return CFG.updateCartItem(d.lineId, d.changes); })
    .then(function (line) { say({ type: 'nova-client:cart-result', id: d.id, ok: true, line: line }); },
          function (e) { say({ type: 'nova-client:cart-result', id: d.id, ok: false, error: e && e.message }); });
}
```

**`updateCartItem` only accepts `jobName`, `notes` and `artNotes`.** Changing options, quantity, size or versions changes the price. For those, remove the line, get a new server-priced item from `/api/client-bot/cart`, and add it again.

## Own cart only

- **Signed in:** Nova's server changes only the cart that belongs to the customer's token, as it does today.
- **Guest:**
  - The cart is the customer's own browser storage. The page only acts on `line_id`s that are in it, and an unknown id throws "That item is no longer in the cart."
  - The page never writes a price it was not given by Nova's server.
  - Update can't change anything that affects the price.
- **Messages:** the embed already accepts messages only from `https://nova.axiomprint.com`. Keep that check for the new types.

## Sign-in during a chat

**Nothing extra is needed.** When a guest signs in, the site moves the browser cart into their server cart and clears the browser copy. The embed already tells the chat with `nova-client:signin`. After that, `getCart()` returns `null` and the server is the source of truth.

## Checklist for the Nova team

**Chat iframe (`client-chat`):**
- [ ] For guests, send `would_send` + `nova_request_id` through `nova-client:add-to-cart`, wait for `cart-result`, and show "In cart" or an error.
- [ ] Send `nova-client:cart-get` before each guest message and include the lines in the request.

**Embed (`client-embed.js`):**
- [ ] Add relays for `cart-get`, `cart-remove` and `cart-update`.

**Nova server:**
- [ ] Return the server-priced `would_send` for guests, with `selectedOption` built as described above.
- [ ] Use the guest lines to answer and to choose remove/update actions.
- [ ] Send price-affecting changes as remove + re-add.

**Testing:**
- [ ] Guest: add → reload page → item still there → sign in → item moved to the account cart.
- [ ] Guest: remove and update; an unknown `line_id` shows an error.
- [ ] Signed in: nothing changes.

**Before going live:** send the site team one real `would_send` example to check the fields.
