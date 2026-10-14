# Nova AR → CRM: "payment received" webhook (spec for the web team)

When Karen clicks **Match & Pay Invoice** in Nova AR, Nova records the match and — once the endpoint below exists — tells
the CRM to record the payment against the invoice(s). A **Pair** (an invoice the CRM already shows as paid) never sends
anything.

## Nova → CRM

`POST {AR_PAY_WEBHOOK_URL}` (set in Nova's `.env`; nothing is sent while it is unset)

Headers
- `Content-Type: application/json`
- `X-Nova-Event: ar.payment`
- `X-Nova-Delivery: nova-ar-<id>` — the same id on a resend; treat as idempotency key
- `X-Nova-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + raw body)>` — secret `AR_PAY_WEBHOOK_SECRET`
  (falls back to `TALKAI_WEBHOOK_SECRET`, the same value the TalkAi webhook uses)

Body
```json
{
  "event": "ar.payment",
  "nova_ar_id": 123,
  "invoice_ids": [133160],
  "amount": 458.96,
  "currency": "USD",
  "paid_on": "2026-10-09",
  "method": "ACH",
  "bank": { "institution": "Wells Fargo", "mask": "0489", "wording": "CITY OF BURBANK 10/09/2026 6145421 AXIOMPRINT INC", "check_no": null },
  "customer_id": 4521,
  "customer": "Burbank Parks & Recreation",
  "matched_by": "karen@axiomprint.com",
  "matched_at": "2026-10-14 16:02:11"
}
```
`invoice_ids` can hold two or three invoices when one deposit pays several; split `amount` by each invoice's balance.
`method` is one of Credit card / ACH / Check #n / Zelle / Venmo / PayPal / Wire / Mobile deposit (check) / Online / Deposit, or empty.

## CRM → Nova (response)

- `200` with `{"ok": true, "payment_id": "<your id>"}` — Nova shows "CRM told (id)" on the Matched row.
- `4xx` / `5xx` with a message — Nova shows "CRM: HTTP n …" and the row has a resend (`POST /api/bookkeeping/ar/:id/pay`).

Verify the signature exactly as for the TalkAi webhook (see `docs/TALKAI_CRM_WEBHOOK.md`), and reject timestamps older than 5 minutes.
