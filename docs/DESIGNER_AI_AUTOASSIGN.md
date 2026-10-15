# Designer AI — AutoAssign API for the CRM

Nova's Designer AI decides **which designer should take a prepress job**. The CRM runs a cron, asks Nova per job, and
makes the assignment itself. Nova never writes to the CRM.

- Base URL: `https://nova.axiomprint.com`
- Auth: `Authorization: Bearer <DESIGNER_API_TOKEN>` — the token is in Nova's `.env` (ask Gary; do not commit it).
  Without the header → `401`. If the token is not set on the server → `503`.
- Content type: `application/json`.

## The one call you need

### `POST /api/designer/auto-assign`

Ask who should take a job.

```json
{ "estimate_id": "E1179165" }
```

`estimate_id` is the E-number or the plain id (`1179165`). Several at once: `{ "estimate_ids": ["E1179165", "E1180496"] }`
(up to 20; the answer is then `{ "ok": true, "results": [ … ] }` with one object per job, in the order sent). Add
`"dry_run": true` to get the answer without Nova recording it as a decision.

**Answer — a designer to put on the job:**

```json
{
  "ok": true,
  "estimate_id": 1179165,
  "e": "E1179165",
  "status": "assigned",
  "designer": { "user_id": 232, "name": "Greg Belarmino", "score": 77, "why": ["did 193 × Postcards in 180 days (+30)", "2 active jobs (-3)"] },
  "reason": "did 193 × Postcards in 180 days (+30) · 2 active jobs (-3)",
  "picks": [
    { "user_id": 232, "name": "Greg Belarmino", "score": 77, "off_shift": false, "at_max": false, "why": ["…"] },
    { "user_id": 219, "name": "Jelly Ace Pamatin", "score": 19, "off_shift": false, "at_max": true,  "why": ["…"] },
    { "user_id": 277, "name": "Alex Vradiy",       "score": 3,  "off_shift": false, "at_max": true,  "why": ["…"] },
    { "user_id": 326, "name": "Max Mazmanyan",     "score": 15, "off_shift": true,  "at_max": false, "why": ["…"] }
  ],
  "match_id": 418,
  "ms": 640,
  "ai": false
}
```

`designer.user_id` is the CRM `user.id` of the designer → add that user to the job's `estimate_team_members` and take
the placeholder (PrePress 1 Tier 1 / PrePress Tier 2) off. `picks` is the full ranking (up to 5) for your logs; you only
act on `designer`.

**Answer — change nothing:** `designer` is `null`. Leave the job exactly as it is.

| `status` | Meaning | What to do |
|---|---|---|
| `assigned` | Nova picked someone | Assign `designer.user_id` in the CRM |
| `already_assigned` | Nova already decided this job in the last 24 h (by a person on the Nova page or an earlier cron run); `designer` repeats that pick | Assign if you have not yet; otherwise nothing |
| `busy` | Everyone is busy — all designers who take jobs are at their max or off shift (or the owner's Overload Logic said so). Nova has marked the job and emailed the team | **Nothing.** The job stays in the queue; a designer picks it up by hand. Ask again on the next run |
| `not_in_queue` | The job is not parked on PrePress Tier 1 / Tier 2 in the prepress stage (already assigned, not in prepress, canceled, or the id is wrong) | Nothing |
| `dry_run` | `dry_run: true` was sent; `designer` is what Nova *would* pick | Nothing |
| `error` | Nova could not answer (`reason` says why — e.g. the CRM database was unreachable) | Nothing; retry on the next run |

Rule of thumb: **act only when `designer` is not `null` and `status` is `assigned` or `already_assigned`.**

### `POST /api/designer/auto-assign/done` (optional, recommended)

Tell Nova what happened, so its History shows the loop closed.

```json
{ "estimate_id": "E1179165", "user_id": 232, "ok": true }
```

or, if the CRM could not make the assignment:

```json
{ "estimate_id": "E1179165", "ok": false, "error": "estimate locked by another user" }
```

With `ok: false` Nova clears its own record of the pick, so the next cron run will match the job again.

## Suggested cron

Every 5–10 minutes during working hours:

1. Select the jobs on the placeholder users **239** (PrePress 1 Tier 1) and **331** (PrePress Tier 2) with
   `estimate_stage = 'prepress'`, not canceled, invoiced (`estimate_invoiceid > 0`) — the same set Nova's Jobs tab shows.
2. `POST /api/designer/auto-assign` with those ids (batches of ≤ 20). Nova matches them one at a time, so a run that
   assigns five jobs spreads them — each pick lowers that designer's score for the next.
3. For every result with `designer` not null: assign `designer.user_id` in the CRM, then `POST …/auto-assign/done`.
4. Everything else: leave the job alone.

Rate: one job takes ~0.5–1 s (a few seconds when the owner's Match Logic is on, which adds a model call). Keep batches
small and don't run two crons at once.

## How Nova decides (so the answers make sense)

Every designer who "takes jobs" starts at 50 and gains / loses points — the `why` list carries each reason with its points:

- **History** — did this product in the last 180 days (+5 a job, up to +30), else the same category (+2, up to +15)
- **Strong sides** — a word from the designer's list found in the product / category / proof type / job name (+12 each, up to +36)
- **Tier 2** — a Tier 2 job: +15 for a Tier 2 designer, −20 for one who is not
- **Hardness** (0–10 per job) against the designer's Hard-jobs level (−6 per point over); **creativity** (design fee,
  "Work with Our Designers", design notes) against the Creative level; **client communication** level on jobs with
  back-and-forth; **languages** named in the job's notes / customer
- **Newer designers** (under 60 jobs in 180 days) get common, easy, non-creative products first
- **Load** — −3 per active job above the lightest designer (up to −30); **fairness** — −4 per pick in the last 2 hours
- **Hours and the cap are hard limits**: a designer who is off shift is capped at 15 and never ranks above anyone on
  shift; one at their Max active is capped at 25. If the best pick is still one of those, the answer is `busy`.

Then the owner's **Match Logic** (plain-English rules on the Nova page) can move scores, and the **Overload Logic** can
declare everyone busy. Scores are relative, not probabilities — 77 % vs 19 % means "clearly Greg", not "77 % likely".

Active jobs = what the CRM board counts: jobs in the prepress stage assigned to the designer whose `prepress_status` is
on their desk (`proof_checking`, `rejected_edits`, `insta_proof_manual`). Hours, levels, strong sides and Max active are
set on the Nova page (Designer AI → Designers).

## Monitoring

Designer AI → **History** on nova.axiomprint.com lists every match — when, the job, who Nova picked with the score and
reasons, the other designers considered with their scores (hover for the reasons), the status (matched / Everyone is
busy / applied in CRM / CRM failed) and the source (Nova page or CRM cron). `match_id` in the answer is that row.

## Errors

| HTTP | Body | Cause |
|---|---|---|
| 400 | `{ "ok": false, "error": "estimate_id or estimate_ids[] required …" }` | No usable id |
| 401 | `{ "ok": false, "error": "bad token" }` | Missing / wrong Bearer token |
| 503 | `{ "ok": false, "error": "DESIGNER_API_TOKEN is not set on the server" }` | Nova side not configured |
| 200 with `status: "error"` | per job | Nova could not read the CRM; retry later |
