# NovaHR (1.20.167)

One place for the AxiomPrint team: clock in and out, time off, the company tree, annual reviews, skills and languages, and reward points. It lives at `/hr` (left menu → **NovaHR**, everyone). The time clock by the door lives at `/hr/kiosk`.

Server code: `hr.js`. Page: `public/hr.html` + `public/hr.js`. Kiosk: `public/hr-kiosk.html`. Vendored libraries: `public/qrcode-generator.js` (MIT, prints the badge QR codes) and `public/jsqr.js` (Apache-2.0, reads them with the camera on browsers without BarcodeDetector).

## Where the data lives

Everything is in Nova's SQLite (`hr_*` tables). **The CRM is read-only.**

- **People** come from CRM `user` (type member). On the first boot every active member is added, except accounts that look like test or system accounts ("test machine", "webdev", "Gary Info"…). More people can be added later with People → Add employee → *From the Axiom CRM*, or typed in by hand.
- **CRM-owned fields** are re-read every 15 minutes: name, work email and phone, username, start date, title, legal name, personal email and phone, birthday, photo, and commission. A field edited in NovaHR is listed in `nova_edited` and the sync leaves it alone. The profile marks each of these fields **CRM** or **NOVA**.
- **The four access flags** (Is submitter, View all projects, Enable mail, View products) are CRM permissions. NovaHR shows them and never changes them.
- **A CRM account that is disabled or blocked** becomes *Inactive* in NovaHR.
- **The company tree** is seeded from CRM `department` (`lead_ids`) and `team` (`lead_ids`, `members`). A department or team edited in NovaHR is marked `edited` (NOVA) and the sync skips it. Settings → Company → *Sync from CRM* (or Company tree → *Sync from CRM*) drops those edits.
- **First boot:** each person's department, role and manager come from the first team they are on. Their manager is that team's lead, or the department head when they lead the team themselves. Department heads report to the CEO, who is named in Settings → Company.
- **Default shift:** Glendale 9–6 converted to each person's own time zone. If Designer AI already has a designer's hours, those are used instead.

Password, token and auth-key columns are never read.

## Roles

| | Employee | Manager | HR admin |
|---|---|---|---|
| Who | everyone | Type = Manager, or anyone with people reporting to them (the whole chain under them) | Nova admins, and Type = Admin |
| Private profile data (personal, pay, time off, reviews, documents) | own | own + their chain | everyone |
| Edit personal info, emergency contact, photo, languages, own PIN | ✓ | ✓ | ✓ |
| Edit work info, job & pay, shift, skill levels, PINs and badges | | their chain | everyone |
| Approve time off, fix and approve timesheets, weekly check-in, shout-outs | | their chain | everyone |
| HR settings, company tree edits, holidays, time clocks, audit log | | | ✓ |

## Clocking in

There are three ways to clock in. Each one records a punch in UTC: `in`, `break`, `back`, `out`.

1. **Web.** From *My time clock* on Today. In Settings → Time clock you can:
   - set *Glendale staff clock in* to *Time clock only*;
   - list office IPs, so that Glendale web punches are only accepted from the office;
   - switch web clock-in off for remote staff.
2. **Kiosk.** A tablet by the door, set up once by an HR admin (Settings → Time clock & PINs → *Make this device a time clock*). After that it needs no sign-in.
   - The device keeps a signed kiosk token, which can be switched off from the same page.
   - A person types their **PIN** or scans their **badge**. A camera works, and so does a USB or Bluetooth barcode scanner, which simply types the code followed by Enter.
   - The screen then shows their photo and only the buttons that make sense right now (for example, Clock in, or Start break / Clock out). The choice expires after 15 seconds.
3. **Mobile** (the next app). The same `POST /api/hr/punch {type, source: 'mobile', lat, lng}` with the person's normal Nova token.

**PINs.**
- They are 4–6 digits; the minimum length is set in Settings.
- Every PIN is unique, and easy ones (repeats, runs like 1234) are refused.
- A PIN is stored only as an HMAC keyed from `JWT_SECRET`. It is shown once, when it is made, and never again.
- People can set their own PIN from Today, or a manager can make one from the person's profile.
- After 5 wrong PINs in a minute, the kiosk locks for 60 seconds.

**Badges.**
- People → *Print badges*. Each badge is CR80 size (2.125 × 3.375 in) and carries the person's photo, name, title, department and a QR code.
- The code is `NHR-<id>-<version>-<signature>`. *Lost — new badge* on the profile raises the version, so the old badge stops working.
- Settings → *Badge needs the PIN too* asks for the PIN after a scan, which stops anyone clocking in with someone else's badge.

## Rules (from the owner's spec)

**Which day a punch counts for.** Shifts are in the person's local hours, and an end hour above 24 means the shift runs past midnight (Armenia 20–29 = 8 pm to 5 am). A punch counts for the shift-day of (punch time − (shift start − 6 h)), so a 1:30 am clock-out belongs to the night before.

**Worked hours.**
- Worked time is in→break/out plus back→break/out.
- Each punch is rounded to the setting (5 minutes by default).
- If someone works over 6 hours without punching a break, the unpaid break (30 minutes) is taken off.
- *Missing* = a past day that has a clock-in and no clock-out.
- *No punch* = a scheduled work day with no punches at all. It is only flagged from the person's first punch in NovaHR onward, so nobody has a flagged history from before NovaHR started.

**Overtime.** Hours over the weekly limit (40). Glendale also counts hours over 8 in a day (California); weekly overtime is then counted on the regular hours only.

**Schedule adherence.**
- *Late* = more than `grace` minutes after the shift start; *very late* = more than `lateAlert` minutes.
- *Left early* = more than `earlyGrace` minutes before the shift end.
- *Missed* = no clock-in or no clock-out on a scheduled day.

**Attendance points.**
- A perfect week earns `perfectWeek` points.
- Otherwise: `perfectWeek − (late + early) × latePenalty − missed × missedPenalty`, never below 0.
- Every `streakWeeks` perfect weeks in a row adds the streak bonus. A week with no scheduled shifts neither counts toward a streak nor breaks it.
- The weekly check-in total is capped at `weeklyCap`.

**Time off days.**
- Days are the person's work days between the two dates, minus their location's holidays. A half day counts as 0.5.
- Glendale holidays also include the website's Closed days (CRM `holidays`), marked WEBSITE.
- **Monthly** accrual earns a twelfth of the yearly allowance each month, starting from the hire month in the first year.
- Carry-over, a person's own allowance, and days used before NovaHR are set per person under the profile's Time off tab → *Adjust balances*.
- A request that crosses New Year is split into two.

**Reviews.**
- Stages: none → self → manager → done.
- The areas (six by default) are editable in Settings → Reviews.
- Overall = the mean of the area scores, labelled with `SCALE[round]`.
- A completed review is read-only; HR can reopen it.
- The printable report uses the eggplant letterhead.

**Redemptions.**
- Points are taken off when someone requests a reward.
- If HR rejects the request, the points go back.
- A catalog item can add leave days ("Paid day off" adds 1 vacation day) when HR marks it fulfilled.

## Emails (Admin → Emails, group NovaHR)

| Kind | Name | When it is sent |
|---|---|---|
| `hr.leave` | Time Off Requests | A request is made (to the manager) and decided (to the person) |
| `hr.late` | Late Clock-in Alert | A clock-in more than `lateAlert` minutes late (to the manager) |
| `hr.missed` | Missed Clock-out | 9 am Glendale, for yesterday (to the person and their manager) |
| `hr.checkin` | Points Earned | Weekly check-in and shout-outs (to the person) |
| `hr.review` | Self-review Reminder | The *Remind* button on Reviews |
| `hr.redeem` | Points Redemption | A reward is redeemed (to `HR_ALERT_TO`, default gary@) |

## Other modules

Designer AI reads NovaHR. For a designer who clocks in through NovaHR, the matcher's Hours part works like this:

- clocked in = on shift, with the minutes left until the end of their NovaHR shift;
- approved time off = out;
- not clocked in yet = off.

Designers who don't clock in yet keep the hours set in Designer AI. This goes through `app.locals.novaHR.liveFor(crmUserId)`.

## API (all JSON; staff routes use the normal Nova bearer token)

```
GET  /api/hr/state                        everything the page draws (filtered by role)
GET  /api/hr/employees/:id                one profile (balances, leave, pay history, docs, reviews, points when allowed)
POST /api/hr/employees                    {crm_user_id} or {name, title, department_id, location, work_email, hire_date, pay_rate}
POST /api/hr/employees/:id                field changes (the server decides which fields the caller may edit)
POST /api/hr/employees/:id/photo          {photo: data URL ≤ 250 KB | null}
POST /api/hr/employees/:id/pin            {pin} | {} = make one | {clear: true}
POST /api/hr/employees/:id/badge-reissue
POST /api/hr/badges                       {ids:[]} → badge codes to print
POST /api/hr/punch                        {type: in|break|back|out, source?: web|mobile, lat?, lng?}
GET  /api/hr/timesheets?week=&mine=1      POST /timesheets/approve {employee_id | all, week}   POST /timesheets/fix {employee_id, date, punch:{type,time} | hours | void_id | clear, reason}
GET  /api/hr/timesheets/export?week=      payroll CSV
GET  /api/hr/adherence?weeks=2|4|8
POST /api/hr/leave                        {type, from, to, half, note, employee_id?, approve?}    POST /leave/preview   POST /leave/:id/approve|decline {note}|cancel
POST /api/hr/reviews/:employeeId          {action: self_save|self_submit|save|complete|reopen, self_text | scores, strengths, growth, goals}
GET  /api/hr/checkins?week=               POST /checkins {employee_id, week, cats, note, send?}   POST /checkins/send-all
POST /api/hr/shoutout {employee_id, points 10|25|50, reason}    POST /api/hr/redeem {k}    POST /api/hr/redemptions/:id {status}
POST /api/hr/settings/:key                attendance | rewards | leave_types | skills | skill_levels | languages | review | clock | org
Kiosk (X-HR-Kiosk header):  GET /api/hr/kiosk/hello · POST /api/hr/kiosk/identify {pin | badge [, pin]} → {person, ticket} · POST /api/hr/kiosk/punch {ticket, type}
```

Every change is written to `hr_audit` (HR settings → Audit log). Pay values are never written into the audit log.

## Decisions the owner still has to make (spec §9)

1. **Remote contractors.** For now they clock in the same way, from the web, and HR can switch that off.
2. **Who sees pay.** The person, their manager chain and HR.
3. **Glendale IP rule.** Available (office IPs / time clock only); off by default.
4. **No-shift weeks.** They keep the streak (neutral).
5. **Redemptions.** HR fulfils them, and a paid day off adds to vacation when fulfilled.
6. **Review areas.** Editable in Settings.
7. **Tree vs profile.** The profile's department and manager are the source of truth; the tree is the picture, seeded from the CRM.
