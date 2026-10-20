# Feature Product Brief: Vendor compliance and the W-9 / COI chase

**Status:** DRAFT for owner approval (Rule 13). Written 2026-10-20 against HEAD `5d62752`, migrations through 154.
**Owner ask (verbatim):** "I also need the COI and W-9 chase function. I didn't see that."
**Capability IDs:** VND-02..07, AP-16, TAX-05/06, CTRL-02 (EC-8), PRT-02, INT-01, INT-13 (04-CAPABILITY-MAP).
**IA anchors:** IA-SPEC v2 decision 16 (one request and chase engine), M-7 (`client_requests.kind = 'vendor_document'`),
§6.2 "Vendor documents" loop, widgets `vc.expiring`, `vc.portal_uploads`, `ap.holds`, `tax.1099`; nav C·Payables·Vendor
compliance (tabs Compliance · Portal uploads · 1099 readiness).
**Design boards:** `design-studio/v2/V1-vendor-compliance.html` (desk) and `V2-vendor-portal-mobile.html` (390 px vendor flow).
**Companion:** `docs/FPB-workforce-app.md` (the same chase engine serves receipts).

---

## 0. The one-paragraph version

Every vendor a client pays carries paperwork obligations that depend on what the vendor is: a 1099-eligible service
provider owes a W-9 whose name and TIN match the IRS; a subcontractor owes a certificate of insurance with the limits,
endorsements and certificate holder the client's contracts require. Today MeritBooks **tracks** these (four doc types,
an AI parser for each, a computed payment hold with audited overrides, a magic-link upload portal), but **nobody asks**:
there is no requirement model, no sender, no scheduler, no reminder log, no TIN match, and no renewal cadence. This brief
turns tracking into a closed loop: **rules decide what each vendor owes → the shared chase engine asks (email, SMS opt-in,
portal link) on a cadence → the vendor uploads on a phone → AI reads the document and checks it against the requirement →
a person accepts → the hold lifts → renewal is chased 30 / 15 / 0 days before expiry.** The AP clerk works an exception
list, never a spreadsheet.

## 1. What exists today (code reality, verified 2026-10-20)

| Piece | Where | State |
|---|---|---|
| Doc store: `vendor_compliance_docs` (W9, GL_COI, WC_COI, WC_EXEMPTION; MISSING/PENDING/VALID/EXPIRED; `chase_reminder_count`, `last_chase_at`, `next_chase_at`) | mig 005 | LIVE. One row per vendor per type. No coverage lines, no carrier, no endorsements, no per-client scope |
| Payment hold: computed from doc state; overrides ONE_TIME / TEMPORARY / PERMANENT; `enforcePaymentAllowed` in the pay path; audit table `vendor_compliance_events` | mig 037, `lib/services/vendor-compliance.ts` | LIVE. Fails open on an unmigrated DB (by design). Every missing/expired doc holds; there's no "this doc doesn't apply to this vendor" |
| Maintenance: flips VALID→EXPIRED, advances `next_chase_at` (biweekly from 60 days out, weekly at ≤14 days or expired), logs `CHASE_SCHEDULED` | same file, `runComplianceMaintenance` | PARTIAL. Advances counters only. **No message is sent** and nothing calls it on a schedule |
| W-9 AI read: `W9_EXTRACT` via the Core gateway; TIN masked inside the module; infers 1099 eligibility from entity type | `lib/vendors/w9-parse.ts`, `/api/vendors/w9-parse` | LIVE (AI dark until Anthropic is funded) |
| COI AI read: `COI_EXTRACT`; carrier, policy #, named insured, holder, additional-insured flag, coverage lines (GL, WC, auto, umbrella, professional, pollution) with each-occurrence and aggregate limits | `lib/vendors/coi-parse.ts`, `/api/vendors/coi-parse` | LIVE. **Confirm persists only GL and WC** (the doc table has no columns for the rest; the parser's own header reports this gap) |
| Vendor portal: magic link, per-vendor, `requested_docs` W9/COI/BANKING, uploads land PENDING in the private `documents` bucket, never flip compliance; rate-limited | mig 142, `app/portal/vendor/[token]`, `/api/portal/vendor/[token]/upload` | LIVE. Desktop-styled; no AI read-back to the vendor; **tokens stored in clear** (`vendor_portal_tokens.token`), unlike IA M-7's "hashed" rule |
| 1099 readiness: candidates at **$600** (`REPORTABLE_THRESHOLD_CENTS = 60_000`), W-9 gaps, NEC vs MISC box, Copy B PDFs, FIRE file | `/api/compliance/1099/readiness.ts`, `lib/tax/form-1099*.ts`, `/compliance-1099` | PARTIAL (transmission needs a TCC). **Threshold is a constant, not dated** (see §11.4) |
| Projects-side docs: `proj.compliance_docs` (LIEN_WAIVER_*, COI, W9, CERTIFIED_PAYROLL; job/commitment-scoped) | mig 1005 | Projects-owned. **Overlaps Books on W9 and COI** (see §2.2) |

Gaps the owner is seeing: no requirement rules, no sender, no SMS, no scheduler (INT-01), no TIN match, no endorsements,
no per-client templates, no renewal cadence the owner recognises, no vendor-facing confirmation, no AP-clerk worklist.

## 2. Ownership (suite matrix, FILE 2) — decisions this brief makes

### 2.1 Object ownership

| Object | Owner | Notes |
|---|---|---|
| Vendor identity (`core.vendors` id, name, `identity_status`) | **Suite Core** | Never copied. A Projects-created vendor enters provisional with `w9_status = MISSING` until Books clears it (matrix rule C) |
| `is_1099_eligible`, `tin_encrypted`, `w9_status`, payment terms, **hold** | **Books** | Matrix row `core.vendors`. Projects never writes these |
| Vendor-level compliance documents (W-9, COI, endorsements, WC exemption, W-8BEN) and their extracted facts | **Books** | `vendor_compliance_docs` + new `vendor_coverages`. One certificate serves every client and job it satisfies (VND-05) |
| Requirement templates (what a vendor type owes, per client) | **Books** | New `compliance_requirement_templates` / `compliance_requirements` |
| Job-specific requirements (owner/GC contract says "name the City of Ankeny as additional insured on J-2614"), lien waivers, certified payroll | **Projects** | `proj.compliance_docs` keeps LIEN_WAIVER_* and CERTIFIED_PAYROLL. For COI it stores a **requirement overlay** that points at the Books document, never a second copy |
| The chase (request, reminders, escalation, delivery log) | **Books M-7 engine** | `client_requests.kind = 'vendor_document'` (IA decision 16) |
| Channels, consent, quiet hours, sender identity (email, SMS, push) | **Suite Core** (new) | Projects and the workforce app need the same delivery service. See FPB-workforce-app §2 |
| TIN-match provider connection and raw TIN custody | **Suite Core** (`core.provider_connections`, capability `TIN_MATCH`; secret path) | Books calls it; the raw TIN never sits in a `public` column (§9) |
| Payment hold enforcement at pay time | **Books** (money-movement authorization is Books-owned, canon §3) | Existing `enforcePaymentAllowed` |

### 2.2 The Projects overlap — resolution to send to the Projects workstream (report, don't edit)

`proj.compliance_docs` allows `doc_type in ('COI','W9')`. Two stores for one vendor's W-9 will drift. Proposed contract:

1. **W-9 is never job-scoped.** Projects reads `core.vendors.w9_status` (Books writes it) and stops creating `W9` rows.
2. **COI**: Projects keeps a row per job requirement with `status` derived from the Books certificate it points at
   (`books_doc_id`), plus anything job-specific (named certificate holder, project-specific additional insured, completed-ops
   tail). Books' requirement check takes the Projects overlay as an extra requirement set for that vendor × job.
3. Event seam: no new event type needed for v1 (both live in one Postgres; Projects reads a Books view
   `v_vendor_compliance_status`, read-only). If a sync event is wanted later it gets a **new name** (FROZEN v3 untouched).

## 3. Job and users

**Job:** make sure no client pays a vendor it can't defend paying: no 1099 filed against a bad TIN, no uninsured
subcontractor on a job site, no backup-withholding penalty, no audit finding. And do it without a human sending
a single reminder email.

| User | What they do here | Home surface |
|---|---|---|
| **AP clerk / bookkeeper** (Dana Lee, Sam Kovac) | Works exceptions: uploads waiting for review, AI reads that disagree with the requirement, vendors who don't answer, bills held | C·Payables·Vendor compliance; widgets `vc.portal_uploads`, `vc.expiring`, `ap.holds` |
| **Accounting manager / controller** | Owns requirement templates and hold policy, grants overrides (AM+ only, already enforced), signs off TIN mismatches and B-notices | Client settings · Vendor requirements; `am.exceptions` |
| **Owner / CFO** | Sees exposure: dollars held, uninsured spend this year, 1099 readiness | `ow.decisions`, `tax.1099` |
| **Vendor** (subcontractor office manager, sole proprietor) | Receives a text or email, uploads on a phone, sees what was read, fixes it, done | `/v/[token]` (390-first) |
| **Vendor's insurance agent** | Receives the COI request directly when the vendor names them; replies with a certificate | email reply or the same portal link |
| **Projects PM** | Sees whether a sub can be scheduled on a job (job-specific requirements met) | Projects; reads Books status |

## 4. Requirement rules (what each vendor owes)

### 4.1 Vendor classification (drives the template)

`vendor_type` is set at creation, suggested by AI from the first bill and the W-9 entity type, confirmed by a person:

| Type | Default requirement set (Merit firm default; every client can override) |
|---|---|
| **1099 service provider** (individual, sole prop, partnership, LLC taxed as P) | W-9 **+ TIN match pass** before the first payment over the 1099 threshold |
| **Corporate supplier** (C/S corp, LLC taxed as C/S, materials only) | W-9 (to prove exemption); TIN match optional (policy) |
| **Subcontractor** (labor on site) | W-9 + TIN match; COI: GL each occurrence ≥ 1,000,000 / aggregate ≥ 2,000,000; auto ≥ 1,000,000 CSL if vehicles on site; WC statutory + employer's liability ≥ 500,000 **or** WC exemption/sole-proprietor waiver per state; umbrella ≥ the client's figure; **additional-insured endorsement** (ongoing CG 20 10 + completed ops CG 20 37 or equivalent); **waiver of subrogation**; **primary & non-contributory**; certificate holder = the client's legal name and address |
| **Professional** (engineer, architect, IT) | W-9 + TIN match; professional liability ≥ client figure |
| **Landlord / utility / government** | Exempt (no chase). Exemption is explicit and audited, never "no rule" |
| **Foreign vendor** | W-8BEN / W-8BEN-E instead of W-9 (new doc type); no TIN match |

### 4.2 Per-client templates

`compliance_requirement_templates` (org, `location_id` nullable = firm default, `vendor_type`, `version`, `status`
DRAFT/ACTIVE). Each template holds `compliance_requirements` rows:

- `kind`: `W9 · W8 · TIN_MATCH · COI_GL · COI_AUTO · COI_WC · WC_EXEMPTION · COI_UMBRELLA · COI_PROFESSIONAL · COI_POLLUTION ·
  END_ADDITIONAL_INSURED · END_WAIVER_SUBROGATION · END_PRIMARY_NONCONTRIB · LICENSE · OTHER_DOC`
- `min_each_occurrence_cents`, `min_aggregate_cents` (bigint cents; null when not a limit)
- `holder_text` (required certificate-holder wording), `min_carrier_rating` (e.g. AM Best A- VII; optional)
- `evidence`: `CERTIFICATE_OK` or `ENDORSEMENT_REQUIRED` (TrustLayer/myCOI practice: a checked box on an ACORD 25 is not
  proof of an additional-insured or waiver endorsement; clients whose contracts require the endorsement form choose this)
- `applies_when` (deterministic predicates only: vendor_type, spend in last 12 months ≥ X, has open commitment on a job,
  state of work). No free logic, same "config, not codegen" rule as the expense and AP policy compilers.
- `hold_mode`: `BLOCK_PAYMENT · WARN_ONLY · NONE`, `grace_days` after expiry before the hold bites (default 0)

Inheritance follows S27's marks: follows the firm default, overrides, or this client only. **Templates can be dropped
as a document** (a client's subcontract insurance exhibit): `COI_REQUIREMENTS_EXTRACT` (new gateway feature) proposes
the rows with source sentences, a person confirms — the same propose → confirm pattern as W2's expense-policy upload.

### 4.3 Evaluation

`evaluateVendorCompliance` changes from "every doc row that exists" to "every requirement that applies":

```
applicable = requirements(template(vendor.type, client)) ∪ projects_overlay(vendor, open jobs)
for each requirement r:
   evidence = best accepted document/coverage satisfying r (limits ≥ min, dates cover today, holder matches, endorsement present if required)
   state(r) = MET | EXPIRING (≤ 30 days) | NOT_MET (missing, short limit, wrong holder, no endorsement) | PENDING_REVIEW | WAIVED
vendor state = worst(state(r)); hold = any r with hold_mode = BLOCK_PAYMENT in NOT_MET (after grace) and no active override
```

The hold stays **computed** (no stored flag to drift), exactly as mig 037 intends. A short limit is a named reason
("GL each occurrence 500,000 on certificate; Artistry requires 1,000,000"), never a generic "non-compliant".

## 5. The chase (shared engine, M-7)

### 5.1 Triggers (who creates the request)

| Trigger | Request |
|---|---|
| Vendor created (any module) and template applies | Welcome request for every NOT_MET requirement, one link, one message |
| First bill drafted for a vendor with no W-9 | W-9 request; bill gets the hold badge immediately (AP-16) |
| Coverage expiring | Renewal request at **T-30**, reminders **T-15** and **T-0**, then every 7 days until cured (owner's cadence, replaces IA Q8's 60-day biweekly default, which stays available as a client override) |
| AI read fails a requirement (short limit, wrong holder, missing endorsement) | Correction request quoting exactly what's wrong, addressed to vendor **and** their agent |
| TIN match fails | W-9 re-request with the IRS name/TIN wording rules; B-notice path if a CP2100 arrives (§6.3) |
| Projects adds a job overlay | Job-specific COI request ("name the City of Ankeny") |
| Manual | AP clerk "Request now" (one click, preview shows the message) |

All requests for one vendor bundle into **one open request with one link** (`client_request_tokens` single-batch), so
the vendor never gets three messages for three documents.

### 5.2 Cadence, channels, escalation

Defaults (tenant → client → vendor override, all audited):

| Item | Missing (new vendor) | Renewal | Correction |
|---|---|---|---|
| Schedule | day 0, 3, 7, then weekly | T-30, T-15, T-0, then weekly | day 0, 3, then weekly |
| Channels | email; SMS if the vendor contact opted in; agent email for COI | same | same |
| Quiet hours | 8 pm–7 am in the vendor's time zone; no weekends for SMS | same | same |
| Escalate | after 3 unanswered: internal escalation to the AP owner of the client, then the client contact who manages that vendor relationship | after T-0: hold applies (policy), PM notified if on an open job | after 2 |
| Stop when | requirement MET or WAIVED; request cancelled; vendor inactive | same | same |

- **Email** via the existing Resend provider (`lib/email/provider.ts`), branded per client (white-label: "Artistry Homes
  needs two documents from Prairie Drywall"). Replies to a per-request inbound address attach to the request
  (shares GATE 4 email ingestion; until it lands, the link is the only return path).
- **SMS** (INT-13, provider not yet chosen) only with recorded opt-in: the vendor ticks "text me about documents" on the
  portal, or the client attests consent when entering a mobile. Message carries STOP/HELP; STOP is honored globally per
  number by Core.
- **Agent email**: COI requests copy the producer named on the vendor's last certificate (extracted `producer` block),
  with the requirement summary attached as a one-page PDF ("What Artistry Homes requires on your certificate"). Billy's
  model of sending directly to the sub's agent is what gets certificates issued correctly the first time.
- Every send writes `request_reminders` (channel, status, provider_message_id) and a `vendor_compliance_events` row.

### 5.3 Vendor portal flow (V2 board)

`/v/[token]` (renamed from `/portal/vendor/[token]`; keep the old path as a redirect). 390-first, 44 px targets, no login.

1. **Open**: client's name and logo, the list of what's owed with one line each on why ("Needed before your next
   payment"), and "Takes about 3 minutes".
2. **W-9**: two ways. (a) **Fill it here**: a guided W-9 (entity type → name → TIN → address → e-sign with the IRS
   perjury statement), which produces a signed W-9 PDF; or (b) upload a photo or PDF of a signed W-9. TIN is entered
   twice or shown masked with a reveal toggle; never echoed in full after submit.
3. **COI**: upload the certificate (camera or file) and optionally the endorsement pages. Or **"Send this to my
   agent"**: vendor types the agent's email; the system sends the agent the requirement sheet and a link of its own.
4. **Read-back**: AI extraction shown back to the vendor field by field next to a crop of where it was read (the V2
   signature). Requirement checks shown plainly: "General liability 1,000,000 each occurrence ✓", "Certificate holder
   should read 'Artistry Homes LLC, 4100 Westown Pkwy, West Des Moines IA' ✗ — ask your agent to reissue". The vendor
   can correct a misread on the W-9 they filled (they are the source), but **cannot edit what was read from a COI**
   (the agent is the source): they can only re-upload or forward to the agent.
5. **Done**: what happens next ("Dana at Merit reviews it today; you'll get an email if anything else is needed"),
   SMS opt-in, and the renewal date we'll remind them about.

AI-down mode: the upload still lands PENDING with "We received it; a person will check it", no read-back.

### 5.4 Review (AP clerk)

Uploads land in **Portal uploads** with the AI read and the requirement check pre-computed. Actions: **Accept**
(writes `vendor_compliance_docs` VALID + `vendor_coverages`, recomputes the hold), **Reject with reason** (auto-sends a
correction request), **Accept with exception** (AM+; e.g. umbrella short by 1M for a 3-day job; time-boxed, audited, a
TEMPORARY override under the hood). Auto-accept is **OFF** by default; the M10 autonomy dial may later allow auto-accept
when every requirement passes at ≥ 0.95 confidence and TIN match passes (never for a correction of a held vendor).

## 6. TIN matching, B-notices, backup withholding

### 6.1 TIN match
- On W-9 accept (and on demand, and annually each November before 1099 season), submit name + TIN + TIN type to the
  `TIN_MATCH` provider. Options: a third-party API (Track1099 lists ~0.39–0.45 per check; Tax1099, Taxbit offer the same),
  or IRS e-Services TIN Matching directly (interactive up to 25 pairs, bulk up to 100,000 per file; needs the payer's
  e-Services enrollment). **Recommendation: provider API for v1** (no IRS enrollment per tenant), IRS bulk later for
  firms that hold their own enrollment.
- Store only the result in `vendor_tin_checks` (provider, result code, matched name variant, checked_at, provider_ref).
  Result codes are surfaced in plain words ("Name and TIN don't match IRS records — common cause: the W-9 used a DBA
  on line 1").
- A mismatch sets `w9_status` back to RECEIVED (not VERIFIED) and opens a correction request.

### 6.2 Where the raw TIN lives
- The matrix allows Books `tin_encrypted` on `core.vendors`. Keep it encrypted with a Core-managed key; decrypt only in
  the server path that calls the TIN-match provider and the 1099 generator. No response body carries it (the S49 fix
  that removed `tin_encrypted` from `/api/vendors` stays enforced by a guard test).
- **Security flag for the security agent:** `W9_EXTRACT` sends the W-9 image (TIN visible) to the model through the
  gateway. Options: (a) accept under a zero-retention agreement; (b) redact the TIN box before the model call and read
  the TIN with deterministic OCR; (c) when the vendor fills the W-9 in the portal, skip AI entirely (TIN typed, never
  imaged). (c) is the default path in this brief; (a) or (b) must be decided before W9_EXTRACT runs on uploaded images
  in production.

### 6.3 B-notices and backup withholding (phase 2, CPA-confirm before build)
- A CP2100/972CG notice from the IRS creates a **B-notice case** per listed payee: first notice → send the payee the
  B-notice letter and a new W-9 request; if not cured within the IRS window, backup withholding starts. Exact business-
  day windows and letter text to be confirmed with tax counsel before build.
- Backup withholding (24%) as a hold policy alternative for 1099 payees with no or bad TIN: payment posts
  DR AP (gross) / CR Cash (net) / CR Backup withholding payable (by role, new account role `BACKUP_WITHHOLDING_PAYABLE`),
  remitted with Form 945. Posted only through `postJournalEntry`; never a coded shortcut.

## 7. Expiration tracking and renewal

- Each `vendor_coverages` row has its own expiration; the certificate's earliest expiring required line drives renewal.
- Nightly `vendors.compliance_scan` (M-12) recomputes states, flips expired, enqueues T-30/T-15/T-0 requests. It
  replaces the counter-only `runComplianceMaintenance` (keep its expiry flip and audit rows).
- **Renewal before it's urgent**: at T-30 the request goes to the agent too, with last year's certificate attached
  ("Please send the renewal certificate for policy GL-4471902 expiring Nov 19").
- **Mid-term cancellation**: if a carrier or agent notifies cancellation (email in) or a Certificial-style network
  connection reports it (phase 3), the coverage flips to NOT_MET immediately and the chase starts.

## 8. Payment holds (policy-configurable)

| Policy | Effect |
|---|---|
| `BLOCK_PAYMENT` (default for W-9 on 1099 types, GL and WC on subcontractors) | Bill can be approved, **not paid**. Pay-run builder skips it with the reason; `ap.holds` lists it with **Request now** / **Request override** |
| `WARN_ONLY` | Pay allowed; badge on bill and run; logged |
| `NONE` | Tracked only |
| Grace | `grace_days` after expiry before BLOCK bites (renewals often arrive a few days late) |
| Overrides | Existing ONE_TIME / TEMPORARY / PERMANENT, AM+ only, reason required, audited (unchanged) |
| Backup withholding | Phase 2 alternative for W-9/TIN failures on 1099 payees (§6.3) |

Holds never block **approval** or **posting** of the bill (the liability is real); they block **release** of money.

## 9. 1099 readiness linkage

- Readiness per vendor = 1099-eligible × paid ≥ threshold × W-9 VERIFIED (TIN match pass) × box classified.
- `tax.1099` widget and `/compliance-1099` read the same `v_vendor_compliance_status`; a W-9 gap on a 1099 candidate is
  a chase request, not a list to export.
- **Threshold must be dated, not a constant.** Code uses `REPORTABLE_THRESHOLD_CENTS = 60_000` ($600). Federal law
  changed the NEC/MISC floor for payments after 2025 (reported as $2,000, indexed). Make it a table keyed by tax year
  and confirm the TY2026 figure with tax counsel before 1099 season. Pre-season (October–November) the scan TIN-matches
  every candidate so January is a filing, not a chase.

## 10. States, lifecycle, audit

**Requirement state:** MET · EXPIRING · NOT_MET · PENDING_REVIEW · WAIVED (time-boxed) · NOT_APPLICABLE.
**Request state** (M-7): open → (answered) → accepted | rejected → closed; cancelled; escalated flag.
**Document state** (existing): MISSING · PENDING · VALID · EXPIRED (+ new REJECTED).

**Audit trail** (extend `vendor_compliance_events.event_type`): REQUEST_SENT, REMINDER_SENT, REMINDER_FAILED,
LINK_OPENED, UPLOAD_RECEIVED, AI_EXTRACTED, REQUIREMENT_FAILED, DOC_ACCEPTED, DOC_REJECTED, TIN_MATCH_PASS,
TIN_MATCH_FAIL, HOLD_APPLIED, HOLD_LIFTED, WAIVER_GRANTED, B_NOTICE_OPENED, plus the existing six. Actor =
`core.users.clerk_user_id`, or `vendor_token:<id>` for portal actions. The vendor 360 shows the trail as a timeline;
the auditor role sees it read-only (PBC: "Provide COIs for all subcontractors paid over 10,000 in FY2026" answers itself).

## 11. Screens and views

| Screen | Who | Content (see V1) |
|---|---|---|
| **Vendor compliance · Compliance tab** | AP clerk, BK | Strip: held $ / vendors held, expiring ≤30d, waiting review, missing. Table grouped by state, worst first: vendor, type, the **requirement strip** (one cell per applicable requirement), chase track (T-30/15/0 or day 0/3/7), next step, one primary action per row. Side panel: selected vendor's requirements vs what's on file, coverage limits against minimums, last messages, timeline |
| **Portal uploads tab** | AP clerk | AI read beside the document, requirement checks, Accept / Reject with reason / Accept with exception |
| **1099 readiness tab** | BK, CTL | Existing page plus TIN-match column and "Request W-9" bulk action |
| **Client settings · Vendor requirements** | AM, CTL | Templates by vendor type with inheritance marks; hold policy; cadence; message preview; drop a contract exhibit to propose a template |
| **Vendor 360 · Compliance section** | anyone with vendor view | Same strip, documents, timeline; "Request now" |
| **Widgets** | | `vc.expiring` (BK/AP/AM), `vc.portal_uploads` (BK), `ap.holds` (BK/AM), `tax.1099` (BK/CTL, Nov–Feb) |
| **Manager view** | AM | Firm-wide: compliance by client, held dollars, longest-unanswered vendors, overrides granted this month (who, why) |

## 12. Permissions (05-RBAC resources)

| Capability | AP clerk / BK | AM / CTL | Owner | Vendor (token) |
|---|---|---|---|---|
| `ctl.vendor_compliance:V` view status, docs (TIN masked) | ✓ | ✓ | ✓ | own only |
| `:E` request, accept/reject uploads | ✓ | ✓ | — | upload only |
| `:K` configure templates, cadence, hold policy | — | ✓ | — | — |
| Grant override / waiver | — | ✓ (AM+, existing rule) | ✓ | — |
| View full TIN | — (nobody in UI) | — | — | — |
| Run TIN match | ✓ | ✓ | — | — |

Token routes: hashed tokens (fix mig 142's clear-text `token`), single vendor, expire when every requested item is
MET or after 30 days, rate-limited on a **shared store** (today's limiter is per-instance; IA R9), anon grants revoked.

## 13. AI dimension (gateway-only, proposes facts)

| Feature | Gateway feature | Proposes | Human gate |
|---|---|---|---|
| W-9 read | `W9_EXTRACT` (exists) | name, entity, TIN (masked), address, 1099 signal | Accept |
| COI read | `COI_EXTRACT` (exists; extend: producer block, holder text, AI/WOS/PNC checkboxes, NAIC) | coverage lines and flags | Accept |
| Endorsement read | `COI_ENDORSEMENT_EXTRACT` (new) | form numbers, named additional insured, blanket vs scheduled | Accept |
| Requirement exhibit read | `COI_REQUIREMENTS_EXTRACT` (new) | template rows with source sentence | Publish |
| Vendor type suggestion | uses first bill + W-9 | `vendor_type` | Confirm |
| Message wording | none (deterministic templates) | — | — |

Requirement **checks are deterministic** (limits compared in cents, dates compared, holder compared by normalized
string with a fuzzy-match score shown, not decided). AI never sets a doc VALID. Every proposal logs to `ai_decisions`.

## 14. Benchmark (Rule 14) — named deltas

Sources: vendor-published material (myCOI, TrustLayer, Billy, Certificial, Track1099); web research budget for this
session ran out before BILL's W-9 tooling could be confirmed, so BILL is assessed from general knowledge and marked so.

| Product | What it does well | MeritBooks delta |
|---|---|---|
| **TrustLayer / myCOI** | Requirement templates, endorsement-level verification, agent outreach | **Match**: templates per client and vendor type, `ENDORSEMENT_REQUIRED` evidence mode, agent copied on requests. **Beat**: the hold is enforced at the pay run in the same ledger; they can only report |
| **Billy** (construction) | Requests to subs *and* their agents; one "wallet" a sub shares across GCs; free to subs | **Match**: agent outreach, free for vendors. **Beat**: one certificate covers every client in the firm (VND-05) and the job overlay comes from Projects with no integration |
| **Certificial** | Network-verified live coverage from agencies/carriers | **Defer** (phase 3 partner connector): only useful where the vendor's agency participates |
| **Track1099 / Tax1099** | W-9 e-collection, TIN match per check | **Use as provider** for TIN match; **beat** on loop closure (match failure → correction request → hold → 1099 readiness, automatically) |
| **BILL** *(general knowledge; not re-verified this session)* | W-9 collection at vendor onboarding, 1099 sync | **Beat**: requirement model and COIs, which BILL's AP product does not center |
| **QuickBooks / Sage** | 1099 flag and W-9 attachment, manual | Everything above |

## 15. Data-model changes (Books band; next migration number per the lead; apply to Supabase first)

All additive, RLS `org_id = get_org_id()`, money bigint cents, no raw TIN anywhere:

1. `compliance_requirement_templates`, `compliance_requirements` (§4.2).
2. `core.vendors.vendor_type` — **core column, Books-owned field** → route through the lead (shared spine).
3. `vendor_coverages` (doc_id, coverage_type, carrier, naic, policy_number, each_occurrence_cents, aggregate_cents,
   effective_date, expiration_date, additional_insured, waiver_of_subrogation, primary_noncontributory, holder_text,
   producer_name, producer_email).
4. `vendor_doc_type_enum` += `COI_AUTO`, `COI_UMBRELLA`, `COI_PROFESSIONAL`, `ENDORSEMENT`, `W8`; status += `REJECTED`.
5. `vendor_tin_checks` (result only).
6. `vendor_compliance_events.event_type` CHECK widened (§10).
7. `vendor_portal_tokens`: add `token_hash`, backfill, drop clear `token` after one release.
8. M-7 tables (`client_requests`, `client_request_tokens`, `request_reminders`) if not yet landed (IA wave 4).
9. View `v_vendor_compliance_status` (security_invoker) for widgets, 1099 readiness and Projects.
10. `tax_year_thresholds` (1099 floor by year).

Guard tests: schema-contract for every new literal; no column named like `tin`/`ssn` unencrypted in `public`/`core`;
tenant isolation on every new table; token route returns 404/410 without leaking tenant names.

## 16. Acceptance criteria (define done)

1. Creating a subcontractor vendor under Artistry Homes' template produces requirement rows and **one** request with one
   link, within one scheduler cycle, without a human action.
2. Emails send on day 0, 3, 7 and weekly; each send has a `request_reminders` row; quiet hours hold an SMS at 8:05 pm
   until 7:00 am vendor time; a STOP reply suppresses SMS for that number tenant-wide.
3. A vendor completes a fill-here W-9 on a 390 px screen with no login in under 3 minutes; TIN never appears unmasked
   after submit, in any response body, or in any log.
4. A COI with GL 500,000 against a 1,000,000 minimum is shown to the vendor and the clerk as a named failure, and an
   automatic correction request goes to the vendor and the producer email on the certificate.
5. Accepting a passing COI lifts the hold on the next pay-run build; a bill for a vendor with a NOT_MET BLOCK
   requirement is excluded from the run with the reason, and `PAYMENT_BLOCKED` is logged if release is attempted.
6. A coverage expiring Nov 19 gets requests on Oct 20, Nov 4 and Nov 19, then weekly; the hold applies on Nov 19 + grace.
7. A TIN-match failure sets `w9_status = RECEIVED`, opens a correction request and shows the vendor on 1099 readiness as
   "TIN mismatch".
8. Every action above writes an audit event with actor; the vendor 360 timeline shows them in order.
9. With AI off, uploads still land PENDING and the clerk can key the coverage manually; nothing blocks.
10. No regression: existing overrides, `enforcePaymentAllowed`, portal uploads and 1099 readiness tests stay green.

## 17. Build sequence (strictly ordered)

1. Shared prerequisites: **INT-01 scheduler + M-12 run log**; **M-7** request engine with email channel; Core channel
   service (email now, SMS when INT-13 provider is picked). Not owned by this module, blocks it.
2. Requirement model (§4) + evaluation rewrite + `v_vendor_compliance_status`; hold reads requirements. Tests first.
3. Chase triggers + cadence on M-7; vendor-document request kind; audit events.
4. Portal v2 (`/v/[token]`): hashed tokens, 390 flow, fill-here W-9 (no AI), COI upload with read-back.
5. COI extract extension + `vendor_coverages` persistence (closes the "GL and WC only" gap).
6. TIN match provider connection + `vendor_tin_checks` + 1099 linkage + dated threshold.
7. Settings UI for templates; requirement-exhibit upload (`COI_REQUIREMENTS_EXTRACT`).
8. Projects overlay contract (with the Projects workstream).
9. Phase 2: B-notices + backup withholding (after CPA sign-off). Phase 3: Certificial-style network connector.

Every slice: builder → verifier → security (token routes, PII, money hold) → chrome-auditor (V1/V2 at 1440 and 390).

## 18. Open decisions for the owner

| # | Decision | Default in this brief |
|---|---|---|
| D1 | SMS provider (shared with receipts and workforce app) | Pick one for INT-13; until then email + agent email only |
| D2 | TIN-match provider (Track1099 vs Tax1099 vs IRS direct) | Third-party API, per-check cost passed through or absorbed (pricing decision) |
| D3 | Renewal cadence 30/15/0 replaces IA Q8's 60-day biweekly | Yes, per owner; 60-day available per client |
| D4 | Endorsement forms required, or certificate checkbox accepted | Per client; Artistry Homes (contracts require them) = `ENDORSEMENT_REQUIRED`, others certificate OK |
| D5 | Auto-accept passing uploads | Off at launch; revisit via M10 dial after 90 days of accept/reject data |
| D6 | W-9 images to the model (TIN exposure) | Fill-here path default; security decides (a)/(b) for uploads |
| D7 | Backup withholding as a hold alternative | Phase 2, after CPA review |
