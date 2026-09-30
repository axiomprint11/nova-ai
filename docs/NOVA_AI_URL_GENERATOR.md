# Axiom Print: Product URL Generator (for Nova AI)

This guide explains how to build Axiom Print product links that open a product page with the options already selected, and how to read a link back into those options.

It has three parts:

1. **Generate:** turn a set of product options into a link.
2. **Decode:** turn a link back into the product options.
3. **Reference code:** a small JavaScript implementation you can use directly.

---

## 1. How a product link works

A product page URL looks like this:

```
https://axiomprint.com/product/{product-slug}-{productId}?shareId={shareId}
```

| Part | Meaning | Example |
|---|---|---|
| `product-slug` | Readable product name (any text) | `business-cards` |
| `productId` | Numeric product ID. It is **always the number after the last `-`** | `12` |
| `shareId` | A 24-character ID pointing to a saved set of selected options | `66f8a1c2e4b0a91d2c3f4e5a` |

When someone opens the link, the page loads the saved options for that `shareId` and pre-selects them in the product calculator (size, paper, quantity and so on).

There are two ways to put the selected options into the link:

| Method | URL looks like | When to use it |
|---|---|---|
| **A. Short link (recommended)** | `...?shareId=66f8a1c2e4b0a91d2c3f4e5a` | Default. Short, clean, and orders placed from it are tracked. |
| **B. Inline config** | `...?config={URL-encoded JSON}` | Offline or bulk generation with no API call. The link is long and orders from it are **not** tracked. |

---

## 2. The `config` object (the selected options)

Both methods use the same `config` object:

```json
{
  "selections": {
    "Size": 1043,
    "Paper": 2210,
    "Quantity": 3107,
    "Job Name": "Spring Promo"
  },
  "selectedMetric": "inch"
}
```

### Fields

| Field | Required | Type | Description |
|---|---|---|---|
| `selections` | **Yes** (must not be empty) | object | Keys are option names, values are the selected choices. See below. |
| `selectedMetric` | No | `"inch"` or `"Feet"` | Unit used for a custom size. Defaults to `"inch"`. |
| `customSize` | Only when Size is `"Custom Size"` | `{ "width": n, "height": n, "depth": n }` | Custom dimensions in inches. |
| `customSizeinFeet` | Only when Size is `"Custom Size"` and unit is Feet | `{ "width": "", "height": "", "depth": "" }` | Custom dimensions in feet. |
| `activeMode` | No | `"portrait"` or `"landscape"` | Orientation, for products that have it. |
| `isCustomQuantity` | No | `true` | Set this when using a quantity that is not in the list. |
| `customQuantity` | With `isCustomQuantity` | number | The custom quantity value. |

### How `selections` works

Every product has a list of **variables** (options), such as `Size`, `Paper`, `Quantity` and `Turnaround`. Each variable has:

- `title`: the option name. **Use this exactly as the key** (it is case-sensitive, and some titles contain spaces or underscores).
- `type`: how it is chosen.
- `items`: the available choices, each with an `id` and a `title` (only for dropdown-style options).

The value you set depends on the `type`:

| Variable `type` | Value to put in `selections` | Example |
|---|---|---|
| `text` or `number` | The raw value | `"Job Name": "Spring Promo"` |
| Anything else (dropdown or choice) | The **`id`** of the chosen item (not its title) | `"Paper": 2210` |

Options you leave out keep the product's default choice.

### Where to get the variables and item IDs

```
GET https://laravelapi.axiomprint.com/api/v1/customers/products/{productId}
```

The variables are in `data.product.variables`, in this form:

```json
[
  {
    "title": "Paper",
    "type": "select",
    "items": [
      { "id": 2210, "title": "14pt Cardstock Gloss" },
      { "id": 2211, "title": "16pt Cardstock Matte" }
    ]
  },
  {
    "title": "Job Name",
    "type": "text",
    "default_value": ""
  }
]
```

Skip items that have `"isHidden": 1`. Customers can't select them.

> Some options depend on others (for example, some papers are only available for some sizes). The page applies selections in order and skips any value that isn't valid for the combination. To avoid this, only combine options that are valid together on the website.

---

## 3. Method A: Short link (recommended)

### Step 1: Save the config and get a `shareId`

```
POST https://website.workroomapp.com/api/v1/product-shares
Content-Type: application/json
```

Request body:

```json
{
  "productId": "12",
  "config": {
    "selections": { "Size": 1043, "Paper": 2210, "Quantity": 3107 },
    "selectedMetric": "inch"
  }
}
```

Response (`201 Created`):

```json
{
  "message": "Product selection shared successfully",
  "data": {
    "id": "66f8a1c2e4b0a91d2c3f4e5a",
    "productId": "12",
    "config": { "selections": { "...": "..." }, "selectedMetric": "inch" },
    "orderCount": 0,
    "orders": [],
    "createdAt": "2026-09-30T10:00:00.000Z",
    "updatedAt": "2026-09-30T10:00:00.000Z"
  }
}
```

`data.id` is the `shareId`.

### Step 2: Build the URL

```
https://axiomprint.com/product/{product-slug}-{productId}?shareId={data.id}
```

Example:

```
https://axiomprint.com/product/business-cards-12?shareId=66f8a1c2e4b0a91d2c3f4e5a
```

---

## 4. Method B: Inline config (no API call)

Put the `config` JSON straight into the URL, URL-encoded:

```
https://axiomprint.com/product/{product-slug}-{productId}?config={encodeURIComponent(JSON.stringify(config))}
```

Example:

```
https://axiomprint.com/product/business-cards-12?config=%7B%22selections%22%3A%7B%22Size%22%3A1043%2C%22Paper%22%3A2210%2C%22Quantity%22%3A3107%7D%2C%22selectedMetric%22%3A%22inch%22%7D
```

If a URL has both `shareId` and `config`, `shareId` is used.

---

## 5. Decoding a link back into selections

1. **Get the product ID:** take the path segment after `/product/` and use the number after the last `-`.
   `business-cards-12` → `12`
2. **Get the config:**
   - If the URL has `shareId`, call:
     ```
     GET https://website.workroomapp.com/api/v1/product-shares/{shareId}
     ```
     The config is in `data.config`. The response also has `data.orderCount` and `data.orders`, which list orders placed from this link.
   - Otherwise, if the URL has `config`, URL-decode it and `JSON.parse` it.
3. **Turn IDs into readable names:** load the product variables (section 2). For each entry in `config.selections`:
   - Find the variable whose `title` matches the key.
   - If its `type` is `text` or `number`, the value is already readable.
   - Otherwise, find the item in `variable.items` whose `id` matches the value and use its `title`.

Result example:

```json
{
  "productId": "12",
  "selections": {
    "Size": "3.5\" x 2\"",
    "Paper": "14pt Cardstock Gloss",
    "Quantity": "500"
  },
  "selectedMetric": "inch"
}
```

### Errors

| Status | Meaning |
|---|---|
| `400` | `shareId` is not a valid 24-character hex ID, or `config` is missing or empty |
| `404` | No saved selection exists for this `shareId` |

---

## 6. Reference implementation (JavaScript, Node 18+ or a browser)

```js
const SITE_URL = 'https://axiomprint.com';
const SHARE_API = 'https://website.workroomapp.com/api/v1/product-shares';
const PRODUCT_API = 'https://laravelapi.axiomprint.com/api/v1/customers/products';

// ---------- Product variables ----------

async function getProductVariables(productId) {
  const res = await fetch(`${PRODUCT_API}/${productId}`);
  const json = await res.json();
  return json?.data?.product?.variables || [];
}

// ---------- Generate ----------

/**
 * Build a product link.
 * @param {object}  opts
 * @param {string}  opts.slug       product slug, e.g. "business-cards"
 * @param {string}  opts.productId  numeric product id, e.g. "12"
 * @param {object}  opts.config     { selections: {...}, selectedMetric?, ... }
 * @param {boolean} [opts.inline]   true = ?config= link (no API call, no order tracking)
 */
async function generateProductUrl({ slug, productId, config, inline = false }) {
  if (!config?.selections || !Object.keys(config.selections).length) {
    throw new Error('config.selections must not be empty');
  }

  const base = `${SITE_URL}/product/${slug}-${productId}`;

  if (inline) {
    return `${base}?config=${encodeURIComponent(JSON.stringify(config))}`;
  }

  const res = await fetch(SHARE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId: String(productId), config }),
  });

  if (!res.ok) throw new Error(`Share create failed: ${res.status}`);

  const { data } = await res.json();
  return `${base}?shareId=${data.id}`;
}

/**
 * Convenience: build selections from readable names instead of ids.
 * e.g. { Paper: '14pt Cardstock Gloss', Quantity: '500', 'Job Name': 'Promo' }
 */
async function selectionsFromTitles(productId, readable) {
  const variables = await getProductVariables(productId);
  const selections = {};

  for (const [title, wanted] of Object.entries(readable)) {
    const variable = variables.find((v) => v.title === title);
    if (!variable) throw new Error(`Unknown option "${title}"`);

    if (variable.type === 'text' || variable.type === 'number') {
      selections[title] = wanted;
      continue;
    }

    const item = (variable.items || []).find(
      (i) => i.isHidden !== 1 && String(i.title).toLowerCase() === String(wanted).toLowerCase(),
    );
    if (!item) throw new Error(`"${wanted}" is not a valid choice for "${title}"`);

    selections[title] = item.id;
  }

  return selections;
}

// ---------- Decode ----------

async function decodeProductUrl(url) {
  const u = new URL(url);
  const segment = u.pathname.split('/product/')[1] || '';
  const productId = (segment.match(/^(.+)-(\d+)$/) || [])[2] || null;

  let config = null;
  let orders = [];

  const shareId = u.searchParams.get('shareId');
  const rawConfig = u.searchParams.get('config');

  if (shareId) {
    const res = await fetch(`${SHARE_API}/${shareId}`);
    if (!res.ok) throw new Error(`Share lookup failed: ${res.status}`);
    const { data } = await res.json();
    config = data.config;
    orders = data.orders || [];
  } else if (rawConfig) {
    config = JSON.parse(rawConfig); // searchParams already URL-decodes
  }

  if (!config) return { productId, config: null, selections: {} };

  const variables = productId ? await getProductVariables(productId) : [];
  const selections = {};

  for (const [title, value] of Object.entries(config.selections || {})) {
    const variable = variables.find((v) => v.title === title);

    if (!variable || variable.type === 'text' || variable.type === 'number') {
      selections[title] = value;
      continue;
    }

    const item = (variable.items || []).find((i) => i.id === value);
    selections[title] = item ? item.title : value;
  }

  return { productId, shareId, config, selections, orders };
}

// ---------- Example ----------

(async () => {
  const productId = '12';
  const selections = await selectionsFromTitles(productId, {
    Paper: '14pt Cardstock Gloss',
    Quantity: '500',
  });

  const url = await generateProductUrl({
    slug: 'business-cards',
    productId,
    config: { selections, selectedMetric: 'inch' },
  });
  console.log('URL:', url);

  const decoded = await decodeProductUrl(url);
  console.log('Decoded:', decoded.selections);
})();
```

---

## 7. Quick checklist

- [ ] Option keys match the variable `title` exactly.
- [ ] Dropdown values are item **ids**. Text and number values are raw values.
- [ ] `selections` is not empty.
- [ ] If Size is `Custom Size`, `customSize` is included (and `customSizeinFeet` if the unit is Feet).
- [ ] Use `shareId` links (Method A) when order tracking matters.
