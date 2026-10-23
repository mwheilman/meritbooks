# Feature Product Brief: Request & chase engine + notifications (Wave 1D)

**Status:** authored 2026-10-23 (slice 1D). **Migration:** `178_request_engine_notifications.sql`.
**Sources:** `docs/audit-2026-10/FEATURE-GAP-AUDIT.md` §2.1, §2.2, PL-01, PL-02, §6.3 Wave 1D; `docs/ia/IA-SPEC.md`
M-7 (requests & chase), M-11 (receipt policy), M-12 (`requests.remind`), M-13 (notifications);
`docs/FPB-vendor-compliance-chase.md` §5; `docs/FPB-workforce-app.md` §4.8–4.9; `docs/SCHEDULER.md`.

## 0. The one-paragraph version

Today nothing sends a reminder: receipt-chase settings are read by nothing, the vendor scan only bumps counters, dunning
is a stub, and there is no notification center. This slice builds the ONE engine every follow-up rides on: a request
row (who owes what, about which record, by when), a cadence that decides when to ask again, quiet hours in the
recipient's time zone, escalation to a person after N unanswered asks, a pluggable "is it done yet?" resolver per kind,
an append-only timeline, hashed magic links, unsubscribe/bounce handling, and an in-app notification center. The first
end-to-end proof is the vendor W-9/COI chase: a vendor missing a W-9 gets a branded email with the existing vendor-portal
link on cadence, and the request closes itself when the document arrives. Receipt chase (2B), the W-9/COI review loop
(2A), client questions (5D) and dunning (2E) plug into it without schema changes.

## 1. Naming decision (IA reconciliation)

IA M-7 sketches `public.client_requests` / `client_request_tokens` / `request_reminders`; the Wave-1 plan (lead)
names `core.requests`, `request_events`, `notifications`, `notification_prefs`. **We build the lead's names in `core`**
(the engine is shared across modules — Projects and Merit Workforce reuse it — so it is Suite-Core-shaped, not
Books-private). Mapping: `client_requests` → `core.requests`; `client_request_tokens` → `core.request_tokens`;
`request_reminders` → `core.request_events` (event_type `sent` rows carry channel / provider id); M-13
`notification_preferences` → `core.notification_prefs`. `pbc_requests` (145) stays; the unified `v_requests_all`
view is deferred to 5D. IA kinds map: `vendor_document` → `w9` | `coi`; `transaction_question`/`information` →
`client_question`; `approval` → `approval_nudge`.

## 2. Users and jobs

| Persona | Job |
|---|---|
| Bookkeeper / AP clerk | "Who still owes me what, how hard have we asked, and what do I do next?" — `/requests` |
| Accounting manager / owner | Gets escalations in the notification panel; sets tenant cadences and quiet hours |
| Vendor / customer / employee (external) | Gets one clear email with one button; can unsubscribe; never needs a login |
| Every signed-in member | Sees an unread count and a notification list with deep links |

## 3. Data model (migration 178, all `core`, service-write, member SELECT)

| Table | Purpose | Key rules |
|---|---|---|
| `core.requests` | One ask. `kind` ∈ receipt · w9 · coi · client_question · document · approval_nudge · dunning. Subject ref (`subject_type`, `subject_id`), recipient (member / vendor contact / customer contact / employee / email) with name, email, phone, timezone; `channels[]` ⊆ email · sms · push · in_app; cadence (`cadence_anchor` created\|due, `cadence_offsets_minutes[]`, `repeat_every_minutes`, `max_sends`, `cadence_slot`); quiet hours; escalation (`escalate_after`, `escalate_to_membership_id`, `escalated_at`); `status` open · sent · snoozed · fulfilled · cancelled · expired; `due_date`, `next_send_at`, `sends_count`; `dedupe_key` | partial UNIQUE `(org_id, dedupe_key)` while open/sent/snoozed — one live request per subject; `location_id` → client-scope RLS (163) |
| `core.request_events` | Append-only timeline: created, sent, delivered, opened, clicked, replied, fulfilled, bounced, complained, unsubscribed, failed, skipped, escalated, snoozed, cancelled, reopened, expired | `dispatch_key` UNIQUE = `request:step:channel` → **a rerun never double-sends** (claim-before-send) |
| `core.request_tokens` | Hashed magic links (sha256 hex; the clear token exists only in the email) | expiring, revocable, one per send; `/r/[token]` resolves by hash |
| `core.request_policies` | Tenant defaults per `policy_key` (default · w9 · coi · coi_renewal · client_question · document · approval_nudge · dunning) | `receipt` is NOT stored here — it reads the existing Settings → Receipt chase values (`organizations.chase_*`), one source of truth |
| `core.request_suppressions` | Per-tenant unsubscribe / STOP / hard-bounce list by (channel, address) | checked before every external send |
| `core.notifications` | In-app notification per membership: kind, title, body, deep link (must start `/`), severity, read_at | member reads **only their own** (`membership_id = caller`) |
| `core.notification_prefs` | Per membership: channels, digest (instant · daily · weekly · off), quiet hours, timezone, muted kinds | read own only |

## 4. Behaviour (field-level)

**Cadence.** A request's send times are `base + offset[i]` for each offset, then every `repeat_every_minutes` after the
last offset, until `max_sends`. `base` = `created_at` (anchor created) or the due date at 09:00 recipient-local (anchor
due — for T-30/T-15/T-0 renewals). After a send the engine advances to the **first slot later than now** — a late
request sends once, never a burst of catch-up mail.

**Defaults** (tenant may override in Requests → Settings):

| Policy | Anchor | Schedule | Escalate after | Max |
|---|---|---|---|---|
| w9 (missing) | created | day 0, 3, 7, then weekly | 3 | 10 |
| coi (missing) | created | day 0, 3, 7, then weekly | 3 | 10 |
| coi_renewal | due (expiry) | T-30, T-15, T-0, then weekly | 3 | 10 |
| client_question | created | day 0, 2, 5, then weekly | 3 | 6 |
| document | created | day 0, 3, 7, then weekly | 3 | 6 |
| approval_nudge | created | day 0, 1, then daily | 2 | 5 |
| dunning | due | T+0, +7, +15, +30 | 3 | 4 |
| receipt | created | Settings → Receipt chase: first reminder, then every follow-up interval | Receipt chase escalation threshold | 10 |
| quiet hours (default) | — | 20:00–07:00 recipient time (org time zone when unknown); receipt uses Receipt chase quiet hours | — | — |

**Quiet hours.** If a send falls inside quiet hours in the recipient's time zone (IANA; fallback org time zone), it
moves to the quiet-hours end (DST-correct). Manual "Send now" honours quiet hours and says when it will go.

**Dispatch** (`dispatchDueRequests(orgId, now)`, scheduler job `requests.remind`, every 15 min): for each due
request — (1) run the kind's resolver; satisfied → `fulfilled` (via resolver), notify the owner, stop; (2) max sends
reached → `expired`, notify owner; (3) quiet hours → defer; (4) per channel: suppressed/bounced/no address →
`skipped`; SMS/push → adapter returns *not configured* → `skipped` (owner decision pending); email → claim
`dispatch_key`, send via Resend, record `sent` + provider id (failure frees the key and retries in 15 min);
in_app (member recipients) → notification; (5) advance cadence; (6) `sends_count ≥ escalate_after` and not yet
escalated → `escalated` event + notification to the escalation member (else the request owner, else tenant admins).
Every read/write is pinned to `org_id`.

**Resolvers** (pluggable, per kind): `w9`/`coi` — satisfied when the vendor's W-9 (or every COI type in the request)
is `VALID` and unexpired, **or** a vendor-portal submission of that type landed after the request was created
("uploaded — awaiting review"; Wave 2A's review re-opens or corrects). Other kinds: no resolver yet (manual fulfil).

**Email.** Merit-branded (Midnight header with the client or tenant name, Electric single button, DM Sans stack,
square geometry, white-label — no hard-coded Merit entity), plain-text alternative, a one-click magic link
`/r/[token]` (records `clicked`, then redirects to the vendor portal for w9/coi; shows a simple landing otherwise) and
an unsubscribe link `/r/[token]/unsubscribe` (adds a suppression, records `unsubscribed`, stops the chase on email).
**Bounces / complaints** arrive on `/api/webhooks/resend` (Svix-signed, `RESEND_WEBHOOK_SECRET`): hard bounce →
`bounced` event, suppression, request `bounced_at`, owner notified to fix the address; open/click/delivered recorded.

**Vendor proof** (`syncVendorComplianceRequests`, same job, before dispatch): for vendors whose W-9 is MISSING/EXPIRED
→ one `w9` request; GL/WC COI MISSING/EXPIRED → one `coi` request (anchor created); VALID COI expiring ≤ 30 days → one
`coi` request anchored on the expiry (renewal cadence). Recipient = `core.vendors.email`; the link reuses (or mints,
90-day) a `vendor_portal_tokens` link. Gated by the policy's **Create automatically** switch (default **off** — owner
decision D1). Manual: Requests → New request → "W-9 / COI from a vendor".

## 5. Screens

| Surface | What the user sees and does |
|---|---|
| **Notifications** (rail foot, kit rule "no bell in the bar") | "Notifications" row with the unread count (brick when an escalation is unread). Opens a 400px drawer: unread first, each with title, one line, age, deep link; "Mark all read"; per-row mark read; email-digest select. Polls every 60 s and on focus. |
| **Requests** `/requests` | Strip: open · due today · escalated · bounced/undeliverable. Tabs by kind (All · W-9/COI · Receipts · Questions · Documents · Approvals · Dunning). Queue table: subject + recipient, kind, age, sends, last sent, next send (with "quiet hours" note), status pip. Row panel: full timeline (every event, channel, provider id), actions **Send now · Snooze (1d/3d/1w) · Mark fulfilled · Cancel** (cancel confirms + reason). **New request** dialog. Loading / empty / error / done states. |
| **Requests → Settings** card | Per-kind cadence (days list + repeat), escalate after, max sends, create-automatically switch, tenant quiet hours + time zone; Receipt row read-only "from Settings → Receipt chase". Email-not-configured notice when Resend is missing. |
| `/r/[token]` | Public, no login, rate-limited; 404 on unknown, 410 on closed/expired, never leaks tenant data beyond the asking client's name. |

## 6. Permissions (until a dedicated `requests` key exists — lead to add)

View `/requests` and the API: `compliance:view`. Create / send now / snooze / cancel / fulfil: `compliance:manage`.
Settings: `settings_system:edit`. Notifications and prefs: any active member, own rows only.

## 7. Benchmark (named deltas)

Ramp/Expensify receipt nudges, TrustLayer/myCOI chase, QBO/Xero invoice reminders. **Match:** cadence, quiet hours,
escalation, auto-stop on fulfilment, unsubscribe. **Beat:** one engine for every ask, an audited per-step timeline with
provider ids, idempotent per step (QBO resends on retry), resolvers close requests from the books themselves.
**Gap (named):** SMS/push (provider decision), inbound email replies (GATE 4), daily digest sender (job
`notifications.digest`, next), watch rules (M-13 §2).

## 8. Acceptance criteria

1. A vendor with a MISSING W-9 and an email, with auto-create on, gets a `w9` request within one cycle and an email
   whose button opens the vendor portal; `request_events` has `created` then `sent` with the Resend id.
2. Re-running the dispatcher at the same instant sends nothing new (one `sent` per step × channel).
3. Reminders follow day 0/3/7/weekly; a send due at 22:00 recipient time goes at 07:00 (America/Chicago and
   America/Los_Angeles both correct across a DST change).
4. After 3 unanswered sends the escalation member (or owner) gets one unread `request_escalated` notification.
5. When the W-9 becomes VALID (or a portal W-9 upload lands) the next cycle marks the request `fulfilled` and sends nothing.
6. Tokens are stored only as sha256; `/r/<clear>` resolves, `/r/<hash>` does not.
7. Members read only their org's requests and only their own notifications; members/anon cannot write any 178 table.
8. A hard bounce webhook marks the request, suppresses the address and notifies the owner; unsubscribe stops email.
9. SMS reports "not configured" (skipped), never "sent".
10. Existing vendor-compliance, business-write-lock and client-scope guard tests stay green.

## 9. Open decisions (owner)

| # | Decision | Default until decided |
|---|---|---|
| D1 | Turn on automatic W-9/COI chase emails to vendors per tenant | Off (manual "New request" works) |
| D2 | SMS provider (Twilio-class, 10DLC) | Email + in-app only |
| D3 | A dedicated `requests` permission key | `compliance:view/manage` |
