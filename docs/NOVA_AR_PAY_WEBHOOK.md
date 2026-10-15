# Nova AR → CRM: record a customer payment on the invoice

*Hand-off for the web team · Nova 1.20.79 · October 15, 2026*

## What this is

**Nova AR** (`nova.axiomprint.com/nova-ar`) is the Accounts Receivable queue. Every customer deposit that lands in the bank
(Wells Fargo, through Plaid) shows up as a row; Nova reads the bank wording, the amount and the date, looks at the open
invoices in the CRM and suggests the invoice it pays. The AR team clicks **Match & Pay Invoice**.

Today that click only records the match in Nova. The AR person then has to open the invoice in the CRM and press **Pay**
by hand (Payment → Now → Invoice), which is the step in the screenshot. We want the Matched click to do that for them.

**Ask:** one endpoint in the CRM that Nova calls when a payment is matched. It records the payment on the invoice(s) the
same way the **Pay** button on the invoice does, so the invoice shows paid, the balance is 0 and the activity log says
where the payment came from.

```
bank deposit ──► Nova AR row ──► Karen clicks "Match & Pay Invoice" ──► POST to the CRM ──► invoice paid in the CRM
                                                                                             activity: "Payment received (Nova AR)"
```

Nova **never writes to the production database**. The only path into the CRM is this endpoint.

## What Nova sends

`POST {AR_PAY_WEBHOOK_URL}` — you give us the URL, we put it in Nova's `.env`. Nothing is sent until it is set.

### Headers

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `NovaAI-AR/1` |
| `X-Nova-Event` | `ar.payment` |
| `X-Nova-Delivery` | `nova-ar-<id>` — **idempotency key.** A resend of the same match carries the same value. If you have already recorded a payment for this delivery id, answer `200` with the same `payment_id` and change nothing. |
| `X-Nova-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + raw body)>` — same scheme as the TalkAi call webhook (`docs/TALKAI_CRM_WEBHOOK.md`). Secret: `AR_PAY_WEBHOOK_SECRET` in Nova's `.env` (falls back to `TALKAI_WEBHOOK_SECRET`, the value you already have). |

### Body

```json
{
  "event": "ar.payment",
  "nova_ar_id": 412,
  "invoice_ids": [134271],
  "amount": 2495.00,
  "currency": "USD",
  "paid_on": "2026-10-14",
  "method": "ACH",
  "bank": {
    "institution": "Wells Fargo",
    "mask": "0489",
    "wording": "PEACE & HAIGHT I PAYMENT 261014 20261014AC",
    "check_no": null
  },
  "customer_id": 1187,
  "customer": "PAX (Peace & Haight)",
  "matched_by": "karen@axiomprint.com",
  "matched_by_name": "Karen Ohanyan",
  "matched_by_crm_user_id": 118,
  "matched_at": "2026-10-14T13:27:04.000Z"
}
```

| Field | Meaning |
|---|---|
| `nova_ar_id` | Nova's row id — the same number as in `X-Nova-Delivery`. Keep it on the payment you create, it is how we trace a question back. |
| `invoice_ids` | CRM `invoice.id` — **not** the `INV134271` display number. Usually one. Two or three when one deposit paid several invoices of the same customer (Nova only matches add-ups of one customer). |
| `amount` | What arrived at the bank, in dollars, two decimals. For one invoice it equals the balance due (or the total) to the cent — Nova only matches exact amounts; a partial payment is never auto-suggested. |
| `paid_on` | The bank's transaction date (`YYYY-MM-DD`). Use it as the payment date, not "today" — the AR team often matches a day or two later. |
| `method` | What Nova read from the wording / channel: `Credit card`, `ACH`, `Check #1234`, `Zelle`, `Venmo`, `PayPal`, `Wire`, `Mobile deposit (check)`, `In branch`, `Online`, `Deposit`, or `null`. Map to your payment-type list; anything you do not know → "Other / Bank". |
| `bank.wording` | The statement line, as the bank sent it. Put it in the payment note / activity — it is what AR looks for when a customer disputes. |
| `bank.check_no` | Only when the wording names a check; else `null`. |
| `customer_id` / `customer` | The CRM customer the invoice(s) belong to, as Nova saw them when matching. Treat it as a cross-check: if the invoice's customer differs, record the payment anyway and flag it in the note. |
| `matched_by` | **Who clicked Match & Pay** — the email the person signed in to Nova with. See *Who did the match* below. |
| `matched_by_name` | Their display name, from Nova's member list or the CRM `user` table. `null` only if neither knows them. |
| `matched_by_crm_user_id` | Their `user.id` in the CRM when the email belongs to a CRM staff member; `null` for a Nova-local admin account (e.g. `novaai`). |
| `matched_at` | When they clicked, UTC ISO. |

### Who did the match (the audit trail)

Every Match & Pay is done by a signed-in person; nothing is matched automatically. Nova signs people in against the CRM's
own `user` table (same email + password as the CRM), so for the AR team `matched_by` is a CRM staff email and
`matched_by_crm_user_id` is that person's CRM id. **Record the payment under that user** — the payment's "created by /
recorded by", and the activity line, should name them exactly as if they had pressed Pay in the CRM themselves. That is
the log you keep: who approved which payment, when (`matched_at`), from which deposit (`nova_ar_id`, `bank.wording`).

Nova keeps the same facts on its side (`bk_ar.matched_by / matched_at` + an audit row `ar.match`), so the two logs can be
compared by `nova_ar_id`.

When `matched_by_crm_user_id` is `null` (a Nova-only admin login), record the payment under a system user named **NovaAI**
and put `matched_by` (the email / login name) in the note so the person is still identifiable.

## What the CRM should do

For each id in `invoice_ids`:

1. Load the invoice. If it is already **paid in full**, do not add a second payment — answer `200` with `"already_paid": true`
   for that invoice (Nova shows the row as paired, not an error).
2. Record a payment exactly as the invoice's **Pay → Now** flow does — the same table, the same status change, the same
   side effects the button has (balance, `payment_status` paid / partial, "On Complete" ↔ paid flags, whatever Pay
   triggers today), so nothing downstream can tell the two apart.
   - payment date = `paid_on`
   - amount = this invoice's share (see split below)
   - payment type = mapped `method`
   - reference / note = `Nova AR #<nova_ar_id> · <bank.wording> · <bank.institution> ••<bank.mask>` (+ `check #` when set)
   - recorded by = the CRM user `matched_by_crm_user_id` (see *Who did the match*); a system user **NovaAI** only when it is `null`
3. Write an **activity-log line** on the invoice, in the feed the screenshot shows: *"Payment received — $2,495.00 by ACH on
   10/14/2026 · matched in Nova AR by Karen"*.
4. **Do not** email the customer a receipt automatically. If the Pay button normally offers "Email Invoice" / a receipt,
   leave that to the AR person — tell us if you would rather send it and we will add a flag.

**Split across several invoices** (`invoice_ids` has 2–3 entries): pay them oldest first, each up to its balance due; the
sum of the balances equals `amount` to the cent (that is the only case Nova matches). If it does not — rounding, a credit
applied in the meantime — pay what you can and return the leftover in `unapplied` so Nova can show it.

**Customer mismatch:** if an invoice belongs to a customer other than `customer_id`, still record the payment on the invoice
(the AR person chose it on purpose) and add "customer differs from Nova's match" to the note.

## What the CRM answers

Success — `200`:
```json
{ "ok": true, "payment_id": "P-88213", "invoices": [ { "id": 134271, "paid": 2495.00, "balance": 0, "status": "paid" } ], "unapplied": 0 }
```
Nova stores `payment_id` and shows **matched · CRM told (P-88213)** on the row. `payment_id` can be any string ≤ 80 chars;
for several invoices one id for the batch is fine.

Already recorded (same `X-Nova-Delivery`, or the invoice was paid before Nova asked) — still `200`:
```json
{ "ok": true, "payment_id": "P-88213", "already_paid": true }
```

Refused — `4xx` with a reason Nova can show the AR person verbatim:
```json
{ "ok": false, "error": "Invoice 134271 is void" }
```
Nova shows **CRM: HTTP 422 Invoice 134271 is void** on the row, keeps the match, and the row has a **resend** (we call the
same URL again with the same delivery id after the person fixes the invoice). Use `401` for a bad signature, `404` for an
unknown invoice id, `409` when the invoice is locked / in a closed period, `422` for anything else that needs a human.

A `5xx` or a timeout (Nova waits 15 s) is treated as "not told yet" and resent by hand from the row.

## Verifying the signature

```
v1 = hex( HMAC_SHA256( secret, t + "." + <raw request body> ) )
```

Verify against the **raw** body bytes before any JSON parsing; reject when `t` is more than 5 minutes from your clock.

```php
public function novaArPayment(Request $request)
{
    $raw = $request->getContent();
    if (!preg_match('/t=(\d+),v1=([a-f0-9]{64})/', $request->header('X-Nova-Signature', ''), $m)) abort(401);
    [, $t, $sig] = $m;
    if (abs(time() - (int) $t) > 300) abort(401);
    $expected = hash_hmac('sha256', $t . '.' . $raw, config('services.nova.ar_secret'));
    if (!hash_equals($expected, $sig)) abort(401);

    $data = json_decode($raw, true);
    $delivery = $request->header('X-Nova-Delivery');          // "nova-ar-412" — idempotency key

    if ($existing = NovaPayment::where('delivery', $delivery)->first()) {
        return response()->json(['ok' => true, 'payment_id' => $existing->payment_id, 'already_paid' => true]);
    }
    // … record the payment on each invoice exactly as the Pay button does, keep $delivery + $data['nova_ar_id'] on it …
    return response()->json(['ok' => true, 'payment_id' => $payment->id, 'invoices' => $rows, 'unapplied' => 0]);
}
```

## Undo

The AR team can press **Undo** on a matched row in Nova (the deposit goes back to Unmatched). Nova does **not** send
anything for an undo today — the payment stays in the CRM and the person reverses it there, as they would any wrong
payment. If you would rather receive it, we can add `X-Nova-Event: ar.payment.void` with `{ "nova_ar_id", "payment_id" }`
to the same URL; say so and it ships with the next release.

## Testing

1. Send us the staging URL + a secret (or tell us to use the TalkAi one). We set `AR_PAY_WEBHOOK_URL` / `AR_PAY_WEBHOOK_SECRET` in
   Nova's `.env` and reload.
2. In Nova AR, any already-matched row has a **resend** that fires the exact request above (`POST /api/bookkeeping/ar/:id/pay`
   on Nova's side) — so you can trigger deliveries on demand without waiting for a new deposit.
3. Expected on the invoice: a payment for the amount on `paid_on`, status paid, balance 0, the activity line, the Nova reference
   in the note. Expected in Nova: the row reads **matched · CRM told (<payment_id>)**.
4. Replay the same request: the invoice must not get a second payment; the answer is `200` + `already_paid`.

## Questions we need answered

- The CRM `invoice.id` is what Nova sends. Confirm that is what the Pay flow keys on (not the INV number).
- Which payment-type values exist on your side, so we map `method` to them exactly.
- For the rare Nova-only admin login (no CRM user id) — a **NovaAI** system user with the login in the note is our suggestion; confirm.
- Do you want the `ar.payment.void` event for Undo now, or later.

Contact: Gary (gary@axiomprint.com). Nova's side of this is `bookkeeping-ar.js` → `payHook()`.
