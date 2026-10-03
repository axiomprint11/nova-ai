# Nova AI — How to Add Items to a Customer's Cart

Follow these instructions whenever you add, change, or read items in a customer's cart on AxiomPrint (`website.workroomapp.com`).

The goal is that every cart item you create is **identical in shape to an item the customer adds themselves on the website**. The cart page, checkout and order system all read the website's shape. Items in any other shape show up wrong or break checkout.

---

## 1. The rule you are breaking today

Today Nova sends `selectedOption` as **plain strings**:

```json
"selectedOption": {
  "Shape": "Rectangle",
  "Size": "3.5 x 2",
  "Paper_Stock": "14PT Coated Both Sides"
}
```

**This is wrong.** Every value in `selectedOption` must be the **full option object** taken from the product catalog, like this:

```json
"selectedOption": {
  "Shape": {
    "id": 10798,
    "variable_id": 2054,
    "title": "Rectangle",
    "type": "shape_list",
    "parent_order": 0,
    "preview_mode": "next3",
    "image": "https://axiomprint.s3.us-west-1.amazonaws.com/ProductVariableItemImages/Label-Landscape-2.svg",
    "base": 0,
    "value": 1,
    "...": "all other catalog fields, see section 4"
  }
}
```

Nova currently also leaves out `printSides`, `customSize`, `selectedMetric`, `activeMode` and the `sample_*` fields. The website always sends them, so you must send them too.

---

## 1A. The keys in `selectedOption` are different for every product

**There is no fixed list of option keys.** Each product defines its own options, and the keys of `selectedOption` are that product's `variables[].title` values. Real examples from the live catalog:

| Product (`productId`) | Keys, in order |
|---|---|
| Classic Business Card (160) | `Shape`, `Size`, `Paper_Stock`, `Printed_Sides`, `Print_Color`, `Finishing`, `Round_Corners`, `Quantity`, `Turnaround` |
| Foil Business Cards (155) | `Shape`, `Size`, `Paper_Stock`, `Printed_Sides`, `Print_Color`, `Finishing`, `Foil_Option`, `Foil_Color`, `Raised_Spot_UV`, `Round_Corners`, `Quantity`, `Turnaround` |
| Vinyl Banner (163) | `Size`, `Material`, `Print_Sides`, `Hemming`, `Pole_Pockets`, `Grommets`, `Custom Grommets`, `Quantity`, `Turnaround` |
| Single Premium Posters (164) | `Type`, `Size`, `Material`, `Print_Sides`, `Print_Color`, `Lamination`, `Quantity`, `Turnaround` |
| Canvas Roll (200) | `Size`, `Material`, `Print_Sides`, `Print_Color`, `Quantity`, `Turnaround` |

Notice how the same idea has different keys: paper is `Paper_Stock` on business cards but `Material` on banners and posters. Sides are `Printed_Sides` on cards but `Print_Sides` on banners. Some keys contain a space (`Custom Grommets`).

The **option titles** also differ per product. Print_Color is `"Full Color (4/4)"` on Classic Business Card, `"4/4 (Full Color Both Sides)"` on Foil Business Cards, and `"Full Color + White (5/5)"` on Clear Adhesive Vinyl.

Rules:

1. **Load the product first, every time.** Never build `selectedOption` from memory, from an earlier product, or from the examples in this document.
2. **Copy each key exactly as `variable.title`:** same capitals, same underscores, same spaces. Never "clean up" a key. `Paper_Stock` must not become `Paper Stock` or `paperStock`, and `Custom Grommets` must not become `Custom_Grommets`.
3. **One key per variable, no more and no less.** Every variable of the product gets a key, including hidden ones. Never add a key the product does not have. For example, there is no `Paper_Stock` on a banner, so do not send one.
4. **`availableKeys` is the same list of keys,** in `variable.order` order.
5. **Map the customer's words to the product's key.** If the customer says "paper", "stock" or "material", use whichever of `Paper_Stock` / `Material` *this* product has. If the customer says "sides", use `Printed_Sides` or `Print_Sides`, whichever exists. If no variable fits what the customer asked for, the product does not offer it. Tell them; do not invent a key.
6. **Find special variables by type or meaning, not by a fixed name:** the size variable is the one with `type: "size_new"`, the paper/material variable has `type: "material_list"`, and the sides variable is the one titled `Printed_Sides` or `Print_Sides`.

---

## 2. Endpoints

Base URL: `https://website.workroomapp.com/api/v1`

| Purpose | Method and path |
|---|---|
| Get the product and its options | `GET /products/product-info/{productId}` |
| Read the customer's cart | `GET /cart/my-cart?userId={userId}` |
| Add one item | `POST /cart/add-item` |
| Add several items at once | `POST /cart/add-multiple-items` |
| Change an item | `PUT /cart/update-item/{cartItemId}` |
| Remove an item | `DELETE /cart/remove-item-by-id/{cartItemId}` |

Identifiers you must not confuse:

- **`userId`**: the customer's **Laravel customer id**, a number such as `23679`. It is *not* a Mongo id.
- **`productId`** (in add requests): the **numeric** `product_id`, such as `160` for Classic Business Card. It is *not* the 24-character Mongo `_id`. The request is rejected if this is not a number.
- **`cartItemId`**: the `id` of an item inside `items[]` of the `my-cart` response (24-character hex).

You do not need to touch the WebSocket. After every successful cart call, the server automatically pushes `cart-updated` to the customer's open browser tabs, and the cart refreshes on its own.

---

## 3. Step-by-step: adding a product

1. **Load the product.** Call `GET /products/product-info/{productId}`. Keep the response; call it `product`.
2. **Pick one item per variable.** `product.variables` is a list of option groups (Shape, Size, Paper_Stock, Quantity, Turnaround, ...). Go through them in `variable.order` order. For **every** variable, choose exactly one entry from `variable.items`:
   - **Only consider allowed items** (see "Dependencies" below).
   - Use the customer's stated choice. Match it against `item.title`, case-insensitive.
   - Some titles appear twice. For example, Classic Business Card has two "3 Business Days" Turnaround items. When several items match, take the one with `default: 1`. If that still ties, take the lowest `order`.
   - If the customer said nothing about this variable, use the allowed item with `default: 1`. If none has `default: 1`, use the first allowed item.
   - Never invent a value that is not in `variable.items`. If the customer asks for something that is not there, or not allowed with their other choices, tell them which choices are valid.
   - Do this for hidden variables too (`hidden: 1`), using the default. **Exception: `Print_Color` must agree with the sides variable** (`Printed_Sides` / `Print_Sides`). If the chosen sides title contains "Back", pick the Print_Color item whose `n/n` code has a non-zero second number (for example `4/4` or `5/5`). Otherwise pick the one ending in `/0` (for example `4/0` or `5/0`). The titles differ per product (`"Full Color (4/4)"`, `"4/4 (Full Color Both Sides)"`, ...), so match on the code, not the whole title. If no item fits, use the default. The catalog default alone is often wrong; Classic Business Card defaults to 4/0 even for two-sided cards.
   - Variables with `type: "text"` (for example `Custom Grommets`) have no items; the customer types a free value. Only fill one if the customer gave that value.

   **Dependencies.** An item can carry `filters`. Each filter that has a `relatedTo` variable and a non-empty `relatedItems` list means: *"this item is allowed only if the option chosen for `relatedTo.title` is one of `relatedItems`"* (compare by `variable_item_id`). Filters with `relatedTo: null` or an empty `relatedItems` impose nothing. Example from Classic Business Card: Finishing "Glossy, 2 Sides" is only allowed when Paper_Stock is "14PT Coated Both Sides" or "16PT Coated Both Sides". If the customer asks for "Glossy, Front Only" on 14PT Coated Both Sides, that is not a valid combination, so tell them and offer the allowed finishes.
3. **Build each option object** from the chosen item, as described in section 4.
4. **Build `selectedOption`.** The key is `variable.title` copied exactly (see section 1A). The value is the object from step 3.
5. **Build `availableKeys`.** This is the list of every `variable.title`, in `variable.order` order.
6. **Fill in the other fields** using section 5.
7. **Get the price** from the same price calculation the website uses for this exact selection. Never send `0` and never guess.
8. **POST `/cart/add-item`.**
9. **Verify.** Call `GET /cart/my-cart?userId=...` and run the checklist in section 8 on the new item.

---

## 4. Building one option object

Start from the catalog item (`variable.items[n]`) and change it as follows:

| Field | Value |
|---|---|
| `id` | `item.variable_item_id` (the **number**, for example `10798`). Do **not** use the Mongo `id`/`_id` string. |
| `variable_id` | `variable.variable_id` (the **number**, for example `2054`). Do **not** use the Mongo string. |
| `type` | `variable.type` (for example `"shape_list"`, `"size_new"`, `"material_list"`, `"list"`, `"radius_list"`, `"quantity_list"`, `"turnaround"`) |
| `parent_order` | `variable.order` |
| `preview_mode` | `variable.preview_mode` (may be `null`) |
| `multiple` | `false` |
| `dieLine` | `null` |
| `swap` | `"true"` for the `size_new` (Size) variable, otherwise `null` |
| `calculation` | `0` |
| `configs` | For the Size variable, copy `variable.configs`. Otherwise keep `item.configs`. |
| `material_id` | `item.material_id`, or if that is `null`, `item.material.id` (for example `29` for 14PT Coated 2 Sides), otherwise `null` |
| `value` | `item.value`, or `0` if it is `null` |

**Remove** these catalog-only fields: `_id`, `__v`, `createdAt`, `updatedAt`, `filters`, `material`, `variable_item_id`.

**Keep** every other field exactly as it is in the catalog (`title`, `name`, `image`, `base`, `default`, `order`, `isHidden`, `custom`, `die_line_id`, `radius`, `corners`, `dayCount`, `cost`, `mass`, `thick`, `highlighted`, `equilateral`, `foil_color`, `punch_file`, `punch_position`, `unwind_direction`, `redirect_url`, `binding_type`, `binding_gap`, `binding_side`).

Reference implementation:

```js
const DROP = ['_id', '__v', 'createdAt', 'updatedAt', 'filters', 'material', 'variable_item_id'];

function buildOption(variable, item) {
  const option = { ...item };
  DROP.forEach((k) => delete option[k]);

  option.id = item.variable_item_id;
  option.variable_id = variable.variable_id;
  option.type = variable.type;
  option.parent_order = variable.order;
  option.preview_mode = variable.preview_mode ?? null;
  option.multiple = false;
  option.dieLine = null;
  option.swap = variable.type === 'size_new' ? 'true' : null;
  option.calculation = 0;
  option.material_id = item.material_id ?? (item.material && item.material.id) ?? null;
  option.value = item.value ?? 0;
  if (variable.type === 'size_new') option.configs = variable.configs;

  return option;
}

// An item is allowed when every filter it has is satisfied by an earlier choice.
function isAllowed(item, chosen /* { variableTitle: catalogItem } */) {
  return (item.filters || []).every((f) => {
    const relatedTitle = f.relatedTo && f.relatedTo.title;
    const related = f.relatedItems || [];
    if (!relatedTitle || related.length === 0) return true;
    const picked = chosen[relatedTitle];
    return !picked || related.some((r) => r.variable_item_id === picked.variable_item_id);
  });
}

function pickItem(variable, wanted, chosen) {
  const allowed = variable.items.filter((i) => isAllowed(i, chosen));
  const byPreference = (a, b) => (b.default - a.default) || (a.order - b.order);

  if (wanted) {
    const matches = allowed
      .filter((i) => i.title.toLowerCase() === String(wanted).toLowerCase())
      .sort(byPreference);
    if (matches.length === 0) {
      throw new Error(`"${wanted}" is not a valid ${variable.title} for this selection. Valid: ${allowed.map((i) => i.title).join(', ')}`);
    }
    return matches[0];
  }
  return allowed.find((i) => i.default === 1) || allowed[0];
}

const SIDES_KEYS = ['Printed_Sides', 'Print_Sides'];

// Print_Color must agree with the sides choice: "n/n" (both sides) or "n/0" (front only).
function pickPrintColor(variable, chosen) {
  const sidesKey = SIDES_KEYS.find((k) => chosen[k]);
  if (!sidesKey) return null;
  const twoSided = /back/i.test(chosen[sidesKey].title);
  const fits = variable.items.filter((i) => {
    const code = i.title.match(/(\d)\/(\d)/);
    return code && (code[2] !== '0') === twoSided && isAllowed(i, chosen);
  });
  return fits.sort((a, b) => (b.default - a.default) || (a.order - b.order))[0] || null;
}

// keys come ONLY from product.variables[].title; nothing is hardcoded per product.
function buildSelectedOption(product, choices /* { [exact variable.title]: wanted item title } */) {
  const variables = [...product.variables].sort((a, b) => a.order - b.order);
  const titles = variables.map((v) => v.title);

  const unknown = Object.keys(choices).filter((k) => !titles.includes(k));
  if (unknown.length) {
    throw new Error(`Product ${product.product_id} has no option(s) ${unknown.join(', ')}. Its options are: ${titles.join(', ')}`);
  }

  const chosen = {};
  const selectedOption = {};

  variables.forEach((variable) => {
    const wanted = choices[variable.title];

    // Free-text options (type "text") have no items; leave them out unless the customer gave a value.
    if (variable.items.length === 0) return;

    let item = null;
    if (!wanted && variable.title === 'Print_Color') item = pickPrintColor(variable, chosen);
    if (!item) item = pickItem(variable, wanted, chosen);

    chosen[variable.title] = item;
    selectedOption[variable.title] = buildOption(variable, item);
  });

  return { selectedOption, availableKeys: titles };
}
```

---

## 5. The other fields

| Field | How to fill it |
|---|---|
| `userId` | Laravel customer id (number or string). Required. |
| `productId` | Numeric `product.product_id`. Required. |
| `price` | Price for this exact selection, from the website's price calculation. |
| `customSize` | Take the chosen item of the size variable (`type: "size_new"`, whatever its title). If its title is like `"3.5 x 2"`, send `{ "width": "3.50", "height": "2.00" }`: strings with 2 decimals, width first. For `"Custom Size"`, use the customer's numbers, kept inside that variable's `configs` `minWidth`/`maxWidth`/`minHeight`/`maxHeight`. If the product has no `size_new` variable, send `{}`. |
| `selectedMetric` | `configs.metric` of the size variable. It is not always inches: Mesh Banner uses `"ft"`. |
| `activeMode` | `"landscape"` if width ≥ height, otherwise `"portrait"`. |
| `printSides` | Built from the chosen item of the sides variable (`Printed_Sides` or `Print_Sides`, whichever the product has). See below. |
| `designType` | What the customer said about artwork: `"Print Ready"` (they have files) or `"Send the Files Later"`. Default `"Print Ready"`. |
| `proofOptions` | `"YES (online PDF proof)"` unless the customer explicitly declines a proof. |
| `artNotes` | Any artwork notes from the customer, otherwise `""`. |
| `sample_base`, `sample_fee`, `sample_per_price` | Copy `product.sample_base`, `product.sample_fee` and `product.sample_per_price`. |
| `parentCategoryId` | `product.product_category_id` |
| `totalQuantity`, `customQuantity` | `0` (the quantity is carried by the `Quantity` option) |
| `versionObject` | `[]` |
| `jobName` | Do not make one up. Only send it if the customer gave a job name. |

`printSides`: send one entry per printed side. If the product has neither `Printed_Sides` nor `Print_Sides`, send front only.

```json
"printSides": [
  { "type": "print", "side": "front", "material_from_id": null, "die_line_from_id": null,
    "need_white_support": false, "need_vdp": false, "version_name": null, "version_order": null },
  { "type": "print", "side": "back",  "material_from_id": null, "die_line_from_id": null,
    "need_white_support": false, "need_vdp": false, "version_name": null, "version_order": null }
]
```

- The title contains "Back" (for example "Front and Back") → front and back entries.
- Anything else (for example "Front Only", "Front Only (Direct)", "Front Only (Reverse)") → the front entry only.

---

## 6. Complete example

Request: *"Add 50 classic business cards, glossy both sides, 3 business days"* for customer `23679`.

> These keys belong to **Classic Business Card (160) only**. A banner, poster or any other product has different keys. Always take them from that product's `variables` (section 1A).

```http
POST https://website.workroomapp.com/api/v1/cart/add-item
Content-Type: application/json
```

```json
{
  "userId": 23679,
  "productId": 160,
  "price": 25.7,
  "selectedOption": {
    "Shape":         { "id": 10798, "variable_id": 2054, "title": "Rectangle",              "type": "shape_list",    "parent_order": 0, "...": "..." },
    "Size":          { "id": 143,   "variable_id": 31,   "title": "3.5 x 2",                "type": "size_new",      "parent_order": 1, "swap": "true", "configs": { "metric": "inch", "...": "..." }, "...": "..." },
    "Paper_Stock":   { "id": 134,   "variable_id": 30,   "title": "14PT Coated Both Sides", "type": "material_list", "parent_order": 2, "...": "..." },
    "Printed_Sides": { "id": 9186,  "variable_id": 1677, "title": "Front and Back",         "type": "list",          "parent_order": 3, "...": "..." },
    "Print_Color":   { "id": 155,   "variable_id": 33,   "title": "Full Color (4/4)",       "type": "list",          "parent_order": 4, "...": "..." },
    "Finishing":     { "id": 149,   "variable_id": 32,   "title": "Glossy, 2 Sides",        "type": "list",          "parent_order": 5, "...": "..." },
    "Round_Corners": { "id": 156,   "variable_id": 34,   "title": "No",                     "type": "radius_list",   "parent_order": 6, "...": "..." },
    "Quantity":      { "id": 164,   "variable_id": 36,   "title": "50",                     "type": "quantity_list", "parent_order": 7, "...": "..." },
    "Turnaround":    { "id": 161,   "variable_id": 35,   "title": "3 Business Days",        "type": "turnaround",    "parent_order": 8, "...": "..." }
  },
  "availableKeys": ["Shape", "Size", "Paper_Stock", "Printed_Sides", "Print_Color", "Finishing", "Round_Corners", "Quantity", "Turnaround"],
  "customSize": { "width": "3.50", "height": "2.00" },
  "selectedMetric": "inch",
  "activeMode": "landscape",
  "printSides": [
    { "type": "print", "side": "front", "material_from_id": null, "die_line_from_id": null, "need_white_support": false, "need_vdp": false, "version_name": null, "version_order": null },
    { "type": "print", "side": "back",  "material_from_id": null, "die_line_from_id": null, "need_white_support": false, "need_vdp": false, "version_name": null, "version_order": null }
  ],
  "designType": "Print Ready",
  "proofOptions": "YES (online PDF proof)",
  "artNotes": "",
  "sample_base": 24,
  "sample_fee": 1,
  "sample_per_price": 1,
  "parentCategoryId": 4,
  "totalQuantity": 0,
  "customQuantity": 0,
  "versionObject": []
}
```

`"...": "..."` stands for the remaining catalog fields from section 4. In the real request, send them all. Do not send the literal `"..."` key.

---

## 7. Changing or removing an item

- **Change options:** rebuild the whole `selectedOption`, `availableKeys`, `printSides`, `customSize`, `activeMode` and `price` with the same rules, then `PUT /cart/update-item/{cartItemId}`. Never send a partial `selectedOption` that contains only the changed option.
- **Remove:** `DELETE /cart/remove-item-by-id/{cartItemId}`.
- **Never** fix a wrong item by adding a second one. Update it or remove it.

---

## 8. Self-check before you tell the customer it is done

Read the cart back (`GET /cart/my-cart?userId=...`) and confirm, for the new item:

- [ ] Every value in `selectedOption` is an **object** with a numeric `id` and a numeric `variable_id`. No value is a plain string.
- [ ] The keys of `selectedOption` are exactly this product's `variables[].title` values, character for character. None is missing (hidden ones included; only an empty free-text option may be left out), and there are no extra keys from another product.
- [ ] `availableKeys` lists the same titles in `variable.order` order.
- [ ] Every `title` matches what the customer asked for, or the product default.
- [ ] `printSides` is not empty and agrees with the sides option (`Printed_Sides` / `Print_Sides`).
- [ ] `customSize` has `width` and `height` and agrees with the size option (`type: "size_new"`).
- [ ] `price` is greater than `0`.
- [ ] `sample_base`, `sample_fee` and `sample_per_price` are present.

If any check fails, fix the item with `update-item`. Do not add a duplicate.

---

## 9. Never do this

- Send `selectedOption` values as strings.
- Use Mongo `_id` strings for `productId`, for option `id`, or for option `variable_id`.
- Invent option titles, prices, or job names.
- Skip variables the customer did not mention. Use their defaults instead.
- Reuse keys from another product or from the examples in this document. Load the product and use its own `variables[].title`.
- Change a key in any way (`Paper_Stock` → `Paper Stock` / `paperStock`, `Custom Grommets` → `Custom_Grommets`). Copy `variable.title` exactly.
- Add a key the product does not have (for example `Paper_Stock` on a banner).
