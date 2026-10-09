# NovaAI phone calls → CRM webhook

**For:** the web / CRM team
**From:** Nova (nova.axiomprint.com), TalkAi
**Status:** sending side is built. It is off until a receiving URL is entered in Nova.

## Why

Clients call the Axiom main line **(747) 888-7777** (Dialpad). NovaAI, our AI phone assistant, answers some of those calls:

| When | What Dialpad does | NovaAI answers on | `call.via` |
|---|---|---|---|
| Opening hours, team doesn't pick up in 20 s | transfers the call | **(747) 335-2887** (used only for this) | `team_missed` |
| Outside opening hours / closed days | routes the call | **(747) 350-0012** | `after_hours` |
| Opening hours, NovaAI in the ring group (testing, e.g. every 5th call) | rings it with the team | **(747) 350-0012** | `regular_hours` |

Dialpad logs every one of these calls as **missed** (it handed the call to another number). So the CSR team sees a missed call and calls the client back, even when NovaAI already handled it.

For now Nova emails the CSR team an AI summary after each call. This webhook is the proper fix. After every call NovaAI answers, Nova POSTs the call to the CRM. The CRM can then show it in the calls table like any other call, with the status **Answered by AI**, the AI summary, the recording and the transcript.

It should look like the other rows in the CRM calls table (CALL · WHEN · CLIENT/CONTACT · JOB · PHONE · MNG · VIA · DURATION · REC · AI SUMMARY). The only difference is the status, which says **Answered by AI**. The column mapping is at the end of this document.

## The request

```
POST <your URL>
Content-Type: application/json
User-Agent: NovaAI-TalkAi/1
X-Nova-Event: call.answered_by_ai
X-Nova-Delivery: talkai-call-74        ← stable per call: upsert on it (or on call.id)
X-Nova-Attempt: 1                      ← 1..5
X-Nova-Signature: t=1791564385,v1=6f1c…  ← HMAC-SHA256, see below
```

- **When:** about 90 seconds after the call ends, once the transcript has arrived (the recording is usually ready by then).
- **Which calls:** real phone calls NovaAI answered. Not test calls, and not an account manager calling their own assistant.
- **Respond:** any `2xx` within 15 seconds. Do the heavy work after you respond.
- **Retries:** if the response isn't `2xx` (or there is a timeout or network error), Nova retries after 1, 5, 30 and 120 minutes (5 attempts in all). There are no retries on `400`, `401`, `403` or `410`, so return those only for requests that will never succeed.
- **Duplicates:** the same call can arrive more than once (a retry, or an admin pressing "send again"). Treat `call.id` as the key and **upsert**.

### Verifying the signature

`X-Nova-Signature: t=<unix seconds>,v1=<hex>`, where

```
v1 = hex( HMAC_SHA256( secret, t + "." + <raw request body> ) )
```

The secret is shared once, out of band. It lives in Nova's `.env` as `TALKAI_WEBHOOK_SECRET` and in yours. Verify against the **raw** body bytes, before any JSON parsing. Reject requests where `t` is more than 5 minutes off from your clock.

**PHP / Laravel**

```php
public function talkAiCall(Request $request)
{
    $raw = $request->getContent();
    if (!preg_match('/t=(\d+),v1=([a-f0-9]{64})/', $request->header('X-Nova-Signature', ''), $m)) abort(401);
    [$all, $t, $sig] = $m;
    if (abs(time() - (int) $t) > 300) abort(401);
    $expected = hash_hmac('sha256', $t . '.' . $raw, config('services.nova.webhook_secret'));
    if (!hash_equals($expected, $sig)) abort(401);

    $data = json_decode($raw, true);
    // upsert on $data['call']['id'] …
    return response()->json(['ok' => true]);
}
```

**Node**

```js
const crypto = require('crypto');
function verify(rawBody, header, secret) {
  const m = /t=(\d+),v1=([a-f0-9]{64})/.exec(header || '');
  if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
  const want = crypto.createHmac('sha256', secret).update(m[1] + '.' + rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[2]));
}
```

## The body

```json
{
  "event": "call.answered_by_ai",
  "version": 1,
  "sent_at": "2026-10-09T16:47:57.000Z",
  "call": {
    "id": 74,
    "status": "answered_by_ai",
    "answered_by": "NovaAI",
    "direction": "inbound",
    "started_at": "2026-10-09T16:46:22.000Z",
    "ended_at": "2026-10-09T16:47:57.000Z",
    "duration_sec": 95,
    "via": "team_missed",
    "via_label": "Team missed call (Dialpad passed it on)",
    "main_line": "+17478887777",
    "answered_on": "+17473352887",
    "language": "en",
    "twilio_call_sid": "CA2f0c9e…",
    "elevenlabs_conversation_id": "conv_01k…",
    "nova_url": "https://nova.axiomprint.com/talk-ai?call=74"
  },
  "caller": {
    "phone": "+18185550123",
    "recognised": true,
    "recognised_by": "caller_id",
    "customer_id": 5137,
    "name": "Jane Sample",
    "company": "Sample Co",
    "email": "jane@example.com",
    "account_manager": { "id": 104, "name": "Account Manager", "email": "am@axiomprint.com" }
  },
  "summary": {
    "text": "Jane from Sample Co called about 500 business cards, 16pt matte. NovaAI quoted $89.50 for 500 and emailed the quote to jane@example.com. She plans to order online today.",
    "callback_needed": false,
    "callback_reason": null,
    "generated_by": "NovaAI"
  },
  "outcome": {
    "result": "handled",
    "message": null,
    "quotes": [
      {
        "product_id": 184,
        "product": "Business Cards",
        "options": [ { "name": "Paper", "value": "16pt Matte" }, { "name": "Sides", "value": "Both sides" } ],
        "prices": [
          { "quantity": 500, "price": 89.5, "list_price": 89.5, "discount_percent": null,
            "ready": "2026-10-14", "order_url": "https://axiomprint.com/product/business-cards-184?shareId=…" }
        ]
      }
    ],
    "emails_sent": [ { "kind": "quote", "to": "jane@example.com", "subject": "Your AxiomPrint quote — Business Cards", "at": "2026-10-09T16:47:30.000Z" } ],
    "jobs_mentioned": [ "E1170601" ]
  },
  "recording": {
    "ready": true,
    "url": "https://nova.axiomprint.com/api/talk/rec/74/1794156385/4a7f…0b97.mp3",
    "expires_at": "2026-11-08T16:47:57.000Z",
    "content_type": "audio/mpeg"
  },
  "transcript": [
    { "speaker": "novaai", "text": "Hi Jane, thanks for calling AxiomPrint, and sorry for the wait…", "at_sec": 0 },
    { "speaker": "caller", "text": "How much are 500 business cards?", "at_sec": 4.2 },
    { "speaker": "novaai", "text": "500 business cards come to $89.50…", "at_sec": 9.8 }
  ]
}
```

### Fields

| Field | Type | Notes |
|---|---|---|
| `event` | string | Always `call.answered_by_ai` for now. Ignore events you don't know. |
| `version` | int | `1`. Fields may be **added** within a version; nothing is removed or renamed without a new version. |
| `call.id` | int | Nova's call id. **The key to upsert on.** |
| `call.status` | string | `answered_by_ai`. Show it as **Answered by AI** in the CALL column. |
| `call.started_at` / `ended_at` | ISO 8601 UTC | Show in Los Angeles time. `ended_at` is `null` if the duration is unknown. |
| `call.duration_sec` | int \| null | DURATION column. |
| `call.via` | `team_missed` \| `after_hours` \| `regular_hours` | VIA column. Suggested labels: "Team missed → AI", "After hours → AI", "AI (ring group)". |
| `call.main_line` | E.164 | The number the client dialled: the Axiom main line, as configured in Nova. |
| `call.answered_on` | E.164 | The Twilio number NovaAI answered on ((747) 335-2887 or (747) 350-0012). |
| `call.language` | string | ISO code of the language spoken (`en`, `es`, `hy`, `ru`, …). |
| `call.twilio_call_sid` | string \| null | Useful to match Twilio logs. |
| `call.nova_url` | URL | The call in Nova (staff sign-in). Good for an "Open in Nova" link. |
| `caller.phone` | E.164 \| null | PHONE column. `null` when caller ID was hidden. |
| `caller.recognised` | bool | `true` when the number is on a customer account, or the caller verified themselves on the call. |
| `caller.recognised_by` | `caller_id` \| `verified` \| `number_on_account` \| `unknown` | `caller_id` means a carrier-verified number on the account. `verified` means they confirmed email, ZIP or order number. `number_on_account` means the number matches but wasn't verified. `unknown` means not a client yet (show the "+" add-client button). |
| `caller.customer_id` | int \| null | `customer.id` in axiomprint_new. CLIENT/CONTACT column. |
| `caller.name`, `caller.company`, `caller.email` | string \| null | |
| `caller.account_manager` | `{id, name, email}` \| null | `user.id` of the customer's manager. MNG column. |
| `summary.text` | string | **AI SUMMARY column.** 2–4 sentences written by NovaAI after the call. |
| `summary.callback_needed` | bool | `true` means someone should call the client (they asked for a person, left a message, hung up early, or NovaAI couldn't finish). Worth a badge or a filter. |
| `summary.callback_reason` | string \| null | One line on what to do, e.g. "Wants artwork reviewed before ordering — call back today". |
| `outcome.result` | `handled` \| `message_taken` \| `needs_callback` \| `transferred` | |
| `outcome.message` | object \| null | When NovaAI took a message: `{topic, caller_name, callback_number, email, text}`. |
| `outcome.quotes` | array | Every price NovaAI gave, with options, quantities, prices, the estimated ready date and the Order now link. |
| `outcome.emails_sent` | array | Emails NovaAI sent the caller on this call (for example their quote). |
| `outcome.jobs_mentioned` | string[] | Job numbers (`E1234567`) mentioned on the call. JOB column. Strip the `E` for `estimate.id`. |
| `recording.url` | URL | REC column. Signed link to the MP3, **no sign-in needed**. Valid until `recording.expires_at` (30 days). Download and store it if you need it longer; the link itself grants access, so don't expose it publicly. |
| `recording.ready` | bool | `false` means it wasn't there when the webhook was sent. The same link starts working once it is (Nova fetches it on request); until then it answers `404`. |
| `transcript[]` | array | `{speaker: "caller" \| "novaai", text, at_sec}` in order. |

Prices are numbers in US dollars. Show them as `$1,678.54`.

## Showing it in the calls table

| CRM column | From |
|---|---|
| CALL | `call.status` → a green **Answered by AI** pill (robot / sparkle icon) |
| WHEN | `call.started_at` (Los Angeles time) |
| CLIENT / CONTACT | `caller.name` + `caller.company`, or the "+" add-client button when `caller.recognised_by = "unknown"` |
| JOB | `outcome.jobs_mentioned` |
| PHONE | `caller.phone` |
| MNG | `caller.account_manager` |
| VIA | `call.via` |
| DURATION | `call.duration_sec` |
| REC | `recording.url` (player) |
| AI SUMMARY | `summary.text` (+ a "Call back" badge when `summary.callback_needed`) |

**Matching the Dialpad "missed" row.** Dialpad will still log its own missed call to (747) 888-7777 from `caller.phone`, a few seconds before `call.started_at`. If the CRM finds that row (same caller number, within about 60 s before `started_at`), it can mark it **Answered by AI** and attach this data, instead of showing two rows.

## Turning it on

1. The CRM team creates the endpoint (HTTPS) and sends Gary the URL.
2. Nova and the CRM share one secret. Gary puts it in Nova's `.env` as `TALKAI_WEBHOOK_SECRET=…` (and restarts Nova); you keep it in your config. Never send it in chat or email.
3. In Nova: **TalkAi → Training → Numbers and messages → CRM webhook URL** → paste the URL → Save. "Secret set ✓" shows next to it.
4. To test without waiting for a real call: open any answered call in TalkAi → **Webhook data** shows exactly what would be sent. An admin can also resend a call:
   `POST /api/admin/talk/calls/:id/handoff {"webhook": true}` (staff sign-in).
   **What it sends** beside the URL field shows the latest real call's payload.

## Later (not built yet)

- `call.updated`, when the recording arrives after the first delivery, or an admin rewrites the summary.
- The CRM telling Nova a CSR followed up (to stop the CSR email for that call).
