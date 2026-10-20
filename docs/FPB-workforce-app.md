# Feature Product Brief: Merit Workforce (the employee app), expense-policy upload, budget upload

**Status:** DRAFT for owner approval (Rule 13). Written 2026-10-20 against HEAD `5d62752`; revised 2026-10-20 for the
owner decisions below.
**Owner decisions (binding, 2026-10-20):** (a) the employee app is named **Merit Workforce**; receipt chase can be
**enabled or disabled per tenant and per client** and lives in Merit Workforce. (b) Payroll is **provider-agnostic**:
any payroll system works; **Gusto** is the likely first API provider. (c) Payroll includes a **commissions** mechanism
(docs/FPB-commissions.md); employees see their **commission statements** in Merit Workforce.
**Owner ask (verbatim):** "We need a workforce app where employees can clock in, see their paycheck, and where the
receipt chase will happen. We need the ability to upload budgets and expense policies."
**Capability IDs:** EXP-01..11, PRT-04, PRL-08, FPA-01, G2/G27 (04-CAPABILITY-MAP); IA-SPEC v2 §3.6.6, §4.13, M-7, M-11,
role `employee`; 08-ONBOARDING-V2 §11.4 (T7 policies), §10.5 / O18 (budgets).
**Design boards:** `design-studio/v2/W1-workforce-app-mobile.html` (390 px, 10 phones), `W2-expense-policy-upload.html`.
Extends S21 (receipt chase, employee side) and S22 (chase board); does not replace them.
**Cross-references:** `docs/FPB-payroll.md` (paystubs, provider), `docs/FPB-vendor-compliance-chase.md` (shared chase
engine), `docs/FPB-reports-fpna.md` (budget upload and budget cycle, being written in parallel).

---

## 0. The one-paragraph version

One app on the employee's phone, signed in with a magic link, that answers the four things a field or office employee
needs from the company's back office: **am I on the clock, what did I get paid (and what commission have I earned),
what receipts do I owe, and what am I owed back.** The app is **Merit Workforce**. It is a **suite-level surface**, not a Books page: the shell, identity and notifications are Suite Core;
each card in it is owned by the module that owns the data: time by **MeritProjects**, pay by the **payroll provider**
(via Books' provider-agnostic payroll seam), commission statements, receipts, card charges, expenses and the expense
policy by **Books**. Canon retired in-app
time tracking from Books (CANON-ANCHOR §2); this brief does **not** rebuild it in Books. It puts Projects' time module
on the employee's phone and lets Books consume approved hours. Alongside it: an expense-policy upload (document → AI
rules → human confirms → engine → employees acknowledge) and the budget upload hand-off to FP&A.

## 1. Ownership: who owns each object (the decision this brief exists to make)

| Object in the app | System of record | Books' relationship | Status today |
|---|---|---|---|
| **The app shell**: sign-in, home composition, nav, install/PWA, settings, device passkey | **Suite Core** | renders Books cards inside it | Not built. Today the only employee surface is the S21 design + `/receipts` desk page |
| **Identity**: `core.users` + `core.memberships(role = employee)` linked to `core.employees` by `clerk_user_id` | **Suite Core** | reads | Role `employee` is PLANNED (IA A-1) |
| **Notifications**: email, SMS (opt-in), web push, quiet hours, consent, STOP handling | **Suite Core** (new channel service) | Books' M-7 chase engine calls it | Email exists (Resend); SMS/push not built (INT-13) |
| **Clock in/out punches, breaks, geofence check, job + cost code on the shift** | **MeritProjects** (time module) | none directly | `proj.time_entries` exists (job, cost code, hours, approval_state). **Punches, breaks, geo, non-job time do not exist** — Projects build (§4.3) |
| **Timesheet (week) and its supervisor approval** | **MeritProjects** | consumes APPROVED hours for payroll (gate `TIMESHEET_PAYROLL`) and job cost | approval_state on `proj.time_entries` exists; no week-level submit, no supervisor routing |
| **Paycheck / paystub detail, W-2, direct-deposit info, tax withholding** | **The tenant's payroll system**, reached through Books' provider-agnostic `PayrollProvider` seam (`lib/payroll/providers`): **Gusto** via API (first provider), any other system (ADP, Paychex, Paylocity, QBO Payroll, …) via the **file adapter** | Books holds run + run-line amounts and the provider document reference; **never PII** | Seam + Gusto adapter skeleton + file adapter built; Gusto sandbox not connected; register import is the path for every non-API system |
| **PTO balance and requests** | **Payroll provider** if it supports it (Gusto: yes); else **informational** Books accrual (FPB-payroll §7) | displays | Seam method `getPtoBalances` built; screen not built |
| **Commission statements** (earned, clawbacks, payable, per-job detail) | **Books** commissions engine (`lib/commissions`, docs/FPB-commissions.md) | owns; paid through the payroll seam as COMMISSION earnings | Engine (pure) built; schema proposed; screen not built |
| **Card charges needing receipts** (card → cardholder map) | **Books** (M-11 `card_holders`, `receipt_policies`) | owns | PLANNED |
| **Receipts** (capture, AI read, match) | **Books** (`receipts`, documents bucket) | owns | LIVE on desk (`/receipts`); mobile capture PLANNED (EXP-03) |
| **Receipt chase** (requests, reminders, escalation) | **Books M-7** (`client_requests.kind = 'receipt'`), delivered in Merit Workforce; **on/off per tenant and per client** (§4.9) | owns | PARTIAL: settings only, no sender (EXP-05); enable flags proposed |
| **Expense reports, mileage, per diem, reimbursement** | **Books** (`lib/expenses/expense-reports.ts`, approver queue, reimbursement batch) | owns | LIVE on desk |
| **Expense policy** (document, compiled rules, versions) | **Books** (`expense_policies`, `policy-schema.ts`) | owns | LIVE: compiler + engine + EC-14 detector |
| **Policy acknowledgment** | **Books** (new `policy_acknowledgments`, generic `policy_kind` so a future MeritHR can adopt handbook acks) | owns | Not built |
| **Budgets** | **Books FP&A** (`public.budgets`) | owns | LIVE incl. deterministic CSV/XLSX import (`/api/budgets/import`) |

**Rules that follow from the table**
1. A module that isn't entitled doesn't show its card; it never shows a dead tile. Books-only tenant: no Clock tab;
   the Pay card shows the provider link or nothing. Projects-only tenant: Clock and Timesheet only.
2. The app never writes another module's data. "Submit timesheet" calls the Projects action; "Snap receipt" calls the
   Books action (suite architecture decision 5: the agent and every UI call the same typed actions).
3. Payroll PII (SSN, bank, withholding) stays at the provider and the Core secret path (matrix `core.employees`).
   The app shows the last 4 of the deposit account only if the provider returns it at render time; it is never stored.
4. Each card carries a small source label ("Time · Projects", "Pay · Gusto", "Receipts · Books") on the design boards;
   in product it lives in the card's overflow ("Where this comes from"), useful for support and for white-label resale.

## 2. Job and users

**Job:** let an employee do their back-office chores in the seconds between real work, so the books get clean hours,
complete receipts and fast reimbursements without anyone chasing by hand.

| User | Need | Today they… |
|---|---|---|
| **Field employee** (Andre Willis, install lead, Heartland Heating & Cooling; company card Ramp ••5512) | clock in at the job with the right cost code, take a break, clock out; snap receipts; log mileage; see pay | text the office, keep receipts in the truck, wait for a paper stub |
| **Office employee** (salaried, card holder) | receipts, expenses, pay; no clock | email receipts to the bookkeeper |
| **Supervisor** (Kelly Brandt, operations manager) | approve the crew's week; approve expense reports; see exceptions (missed punch, off-site punch) | chases on Friday |
| **Bookkeeper / payroll runner** (Sam Kovac) | approved hours land in payroll with job/cost code; receipts arrive matched | re-keys |
| **Controller / tenant admin** | publish the expense policy; know who acknowledged | emails a PDF |

## 3. Access and identity

- **Sign-in**: magic link by SMS or email to the number/address on the employee record (no password). Optional SSO via
  the tenant's Clerk connection for office staff. After first sign-in, a device **passkey** (Face ID / fingerprint) keeps
  them signed in for 30 days; sensitive screens (paystub, W-2) re-prompt the passkey.
- **Deep links without sign-in** (IA Q2): a chase text opens `/r/[token]` straight to one charge (S21). Pay and time
  always require sign-in; tokens never open a paystub.
- **Install**: PWA ("Add to Home Screen"), offline shell; punches made offline queue with device time + a server
  reconciliation flag (§4.3). Native wrapper later only if push on iOS PWA proves unreliable.
- **Multi-company**: an employee of two clients sees a company switcher at the top of Home (one membership each).
- **Name and branding (owner decision a):** the app is **Merit Workforce** (home-screen name, sign-in page, emails,
  push sender). Inside the app, Home shows the employer's logo and primary color ("Heartland Heating & Cooling" on
  Merit Workforce). A reseller-level app-name override for white-label resale is a later option, not a tenant setting.

## 4. Screens (W1 board shows each at 390 × 844)

### 4.1 Home
One screen, ordered by what needs doing now: **clock status card** (on the clock 2 h 41 m at J-2614, cost code 23 05,
"Start break" / "Clock out"), **receipts owed** (count + amount, "Snap the oldest"; hidden when receipt chase is off for this
client, §4.9), **next paycheck** (date, "View last stub"), **commissions this period** (for employees on a plan:
earned to date, "View statement"), **expense report** in progress, **policy to acknowledge** (when one is pending). Bottom tabs: Home · Time ·
Receipts · Pay · More (expenses, PTO, documents, settings). Done state: "Nothing owed. Next paycheck Fri Oct 30."

### 4.2 Receipts (Books)
As designed in S21: chase text → one charge → camera finds edges → AI read shown back → job prompt from policy → done
with what's left. Additions: the job picker uses **the job/cost code the employee was clocked into at the time of the
charge** as the default (Projects time × Books charge, read-only join through Core IDs). This is the one cross-module
convenience, and it removes the most common coding error in field spend.

### 4.3 Clock in / out, breaks (Projects time module)
- **Clock in**: pick job (the crew's scheduled jobs for today first, then search), pick cost code (job's codes, last
  used first), optional photo/note. **Geofence (optional per tenant)**: if the job has a site location and the tenant
  enabled it, the punch records "on site / 0.3 mi away"; off-site punches are **allowed and flagged**, never blocked
  (blocking punches creates wage-and-hour risk). Location is captured **only at the punch**, never tracked between.
- **Switch job/cost code** mid-shift: closes one segment, opens the next.
- **Breaks**: start/end; meal vs rest; the tenant's state rules decide paid/unpaid and reminders ("You've worked 5 h;
  take your meal break"). Missed-break attestation at clock-out where state law calls for it.
- **Clock out**: shift summary with segments by job/cost code; attest "my time is accurate" (required where the tenant
  turns it on).
- **Non-job time** (shop, training, office): Projects needs either a nullable `job_id` with a department, or a standing
  internal job per department. **Decision for the Projects workstream** (reported, not decided here). Without it, office
  hourly staff can't use the clock.
- **Data (Projects build, `1xxx` band):** `proj.time_punches` (employee, kind IN/OUT/BREAK_START/BREAK_END/SWITCH,
  at timestamptz, device_time, job_id, cost_code_id, geo_status, lat/lng at punch only, source app/kiosk/manual,
  offline_queued) → derived `proj.time_entries` per segment (existing table). Edits after submit go through a correction
  request with reason, never silent.

### 4.4 Timesheet week (Projects; approval by supervisor)
Seven day rows, each a **shift strip** (segments by job, breaks as gaps, punches as the brand slash; the W1 signature),
daily and weekly totals, overtime shown as it accrues, exceptions inline (missed punch, off-site). **Submit week** →
supervisor (crew lead or department head per the approval chain, mig 092 N-step workflows) approves or returns with a
note. Approved hours become `APPROVED` time entries; payroll pulls them (FPB-payroll §5, `TIMESHEET_PAYROLL` gate) and
labor cost lands on the job with the run (JOB_COST rides FROZEN v3 unchanged).

### 4.5 Pay (any payroll provider, via Books' provider-agnostic seam)
- **Next paycheck** date (from `payroll.pay_schedules`), **last paycheck** net and gross, hours paid vs hours approved
  (they should tie; if not, "Ask payroll" opens a request to the payroll runner).
- **Paystub detail** (earnings, taxes, deductions, YTD) rendered from the provider's API or embedded component at view
  time, not stored; PDF download from the provider. Books' `run_lines` supplies gross/net and the dimension split
  ("Billed to: J-2614 41.5 h · J-2633 38.0 h") — the ledger-native part no provider can show.
- **W-2** (January) and **PTO balance** when the provider exposes them (`getDocumentLinks`, `getPtoBalances`; Gusto
  supports both). Pay stubs and W-2 PDFs are streamed through a server proxy at view time and never stored.
- **Provider-agnostic (owner decision b):** what the Pay tab can show depends only on the adapter's advertised
  `capabilities`, never on a hardcoded provider. **Gusto** (API): stubs, W-2, PTO in-app. **Any other system** (file
  adapter, register import): the Pay tab shows Books' own run figures from the imported register and says where stubs
  are ("Your stubs are in ADP. Open ADP" — the portal URL the tenant set on the connection), and shows nothing invented.
- Re-prompt passkey on open; amounts hidden behind "Show" by default on shared devices (setting).

### 4.5.1 Commissions (Books; owner decision c)
- For employees assigned a commission plan: **this period so far** (earned, clawbacks, net), **last statement**
  (approved / paid, with the payroll date it was paid on), and **per-job detail**: job, basis (sold / installed /
  invoiced / paid), basis amount, rate, commission, and a plain-English line from the engine ("5.00% of revenue × 50%
  split"; "Clawback: cancelled on Nov 15"). A negative balance carried forward is shown honestly with the plan's rule.
- **Dispute**: "Question this line" opens a request to the employee's manager with the line attached; the manager can
  add an ADJUSTMENT line (reason required, audited) before approving the statement.
- Statements are read-only for the employee; approval is a manager action on the desk (FPB-commissions §6). Paid
  commissions also appear on the pay stub as a "Commission" earning (Gusto) or in the outside system's stub (file).

### 4.6 Expenses (Books)
Mileage (map distance, IRS rate from the active policy's `mileageRateCentsPerMile`), per diem (GSA by city, policy
override), out-of-pocket with receipt. A report groups lines; the **policy engine evaluates each line live** and says
why in plain words before submit ("Lodging cap in Des Moines is 159.00; this is 184.00 — add a reason or it goes to
Kelly as an exception"). Reimbursement: AP reimbursement batch (existing) or a non-taxable reimbursement line on the next
payroll run (FPB-payroll earnings type) — **tenant setting**, default AP batch.

### 4.7 Policy acknowledgment (Books)
When a policy version is published to the employee's company, Home shows "Read and acknowledge the 2026 travel and
expense policy". The screen shows a **plain-language summary generated from the compiled rules** (not a model summary:
deterministic text from the ruleset, e.g. "Receipts for anything 25.00 and over"), the full document behind "Read the
full policy", and **Acknowledge** (typed name or passkey). Stored: policy id + version + membership + timestamp +
document hash. Expense submission is **allowed but flagged** until acknowledged (tenant can make it blocking).

### 4.8 Notifications
| Event | Channel default | Owner of the event |
|---|---|---|
| Card charge needs receipt (only when receipt chase is on for the client, §4.9) | push, then SMS if opted in; quiet hours | Books M-7 |
| Forgot to clock out (geofence exit or 12 h open) | push | Projects |
| Timesheet due / returned | push + email | Projects |
| Expense approved / returned / paid | push | Books |
| Payday / stub ready | push | Books (from provider webhook, or register import for file-based payroll) |
| Commission statement ready / approved | push + email | Books (commissions) |
| Policy to acknowledge | push + email | Books |
One daily digest instead of many when more than 3 are due; STOP and quiet hours honored by the Core channel service.

### 4.9 Receipt chase on/off, per tenant and per client (owner decision a)
**Settings.** Two switches, both on the desk (Settings · Receipts & expenses), audited:
- **Tenant switch** (`organizations.receipt_chase_enabled`, default **on**): the master switch for the whole tenant.
- **Client switch** (`company_policies.receipt_chase_enabled`, nullable; null = follow the tenant): lets a firm turn
  chase on for some clients and off for others (e.g. a client whose own office collects receipts).
- **Effective** = tenant on AND (client switch is null or on). A client cannot turn chase on when the tenant has it off.
**Effect on reminders.**
- Off → no new receipt requests are created for that client's card charges, the chase scheduler skips the client, and
  **open reminders stop** (pending sends cancelled, not just paused; escalation counters frozen). Nothing is deleted:
  open receipt requests stay visible on the desk as "chase off" so the bookkeeper can still match receipts.
- Merit Workforce hides the "Receipts owed" card and the chase deep links for that client; employees can still snap and
  upload receipts voluntarily, and those still match.
- Turning chase back on does **not** back-fill a burst of reminders: only charges after the switch-on time, plus open
  requests younger than the tenant's chase window, resume on the normal cadence (respecting quiet hours).
- Interval, quiet hours, channel and escalation stay where they are today (`organizations.chase_*`,
  `company_policies.receipt_chase_interval_minutes`, `receipt_quiet_hours_*`); the switches only gate them.
- The vendor-compliance chase (shared M-7 engine) should adopt the same per-tenant / per-client switch pattern.

## 5. Expense-policy upload (W2 board)

**Flow:** drop the policy (PDF, DOCX, or paste) → `EXPENSE_POLICY_EXTRACT` (exists, `policy-compile.ts`) proposes a
ruleset that must validate against `policy-schema.ts` (config, never code) → review screen shows **each rule next to the
sentence it came from** (the W2 signature: the source tether), plus a list of **unmapped clauses** the engine won't
enforce → reviewer edits or rejects rules → **simulate** on the last 90 days of expense lines (how many would have been
flagged / blocked, which people) → **Publish** as a new version → employees are asked to acknowledge (§4.7).

| Step | What exists | What to build |
|---|---|---|
| Upload + parse | `/api/expenses/policy/parse`, compiler, Zod schema | DOCX → text (deterministic) before the gateway call; page images for scanned PDFs |
| Rule ↔ sentence | compiler keeps `sourceSummary`, `unmappedClauses` | add `source_spans` (page, char range) per rule in the proposal (not in the persisted ruleset shape — keep shape v1 stable, store spans on the `ai_decisions` row) |
| Review/edit | `/expenses/policy` page | split view, per-rule accept/edit/reject, severity toggle WARN/BLOCK |
| Simulate | engine is pure (`evaluateExpense`, `evaluateReport`) | run over the last 90 days' lines; deterministic |
| Publish | `activate` route, one ACTIVE per org | **per client** (`expense_policies.location_id`, nullable = all clients) — today the table is org-wide only |
| Acknowledge | — | `policy_acknowledgments` + Home card + compliance view "38 of 41 acknowledged" |
| Onboarding | 08 §11.4 says EXPENSE_POLICY should route here (G-ON-6) | route the Smart Intake EXPENSE_POLICY type to this flow |
| AI down | — | manual rule builder with the same schema; the document stays attached as reference |

Rules that need data not present (e.g. receipts on card charges need a card → cardholder map) become **follow-up
cards** on publish, as 08 §11.4 specifies.

## 6. Budget upload (cross-reference to FPB-reports-fpna)

Budget ownership and the budget cycle (department-head submissions, versions, reforecast) belong to
`docs/FPB-reports-fpna.md`. This brief fixes only the **entry points** so the owner's "upload budgets" ask has one answer:

- **Desk:** Budgets · Plan · **Import budget** uses the existing deterministic loader (`/api/budgets/import`: CSV/XLSX,
  account match by number then name, 12 monthly cells, `dryRun` preview, idempotent upsert). Needed there (FP&A FPB):
  department/class columns per row, version tag, and an AI mapping fallback for messy files.
- **Onboarding:** O18 budgets card (08 §10.5) uses the same loader.
- **Merit Workforce:** none. Employees don't upload budgets; department heads submitting a budget is a desk flow in the
  budget cycle (FPA-06), not the employee app.

## 7. States

| Surface | Loading | Empty | Done | Error | Offline / AI down |
|---|---|---|---|---|---|
| Home | skeleton cards in final order | first sign-in: "Your company set this up for receipts and pay" + what each tab does | "Nothing owed" | card-level, never page | cached last state + "Offline · 2 punches will send when you're back" |
| Clock | — | no jobs assigned: search all jobs | — | punch failed → queued, never lost | offline punch with device time, flagged for review |
| Receipts | — | "No card on file" / "All caught up" | yes | upload retry | AI down: receipt stored, "Dana will match it" |
| Pay | — | file-based payroll: Books run figures + portal link | — | provider down: "Pay details are temporarily unavailable from Gusto" | — |
| Commissions | — | not on a plan: tab hidden; on a plan, nothing yet: "No commissionable jobs this period" | statement paid | card-level | cached last statement |
| Policy review (W2) | parse progress per page | no policy: start from Merit's template | published + ack progress | schema validation errors listed by rule | manual builder |

## 8. Permissions (role `employee`, IA §2.2)

Own records only: `exp.receipts V C E D (own)`, `exp.reports V C E (own)`, `cards.transactions V (own)`,
`req.client_requests V E (assigned to me)`, `comp.my_statements V (own)` (commission statements, new), `time.punches C (own)` and `time.entries V E (own, before approval)` (Projects
resources, to add to the capability registry), `payroll.my_pay V (own)` (new, renders provider data, no PII stored).
No ledger, money, configure or cross-client capability (audience ceiling). Supervisor approval of time is a Projects
capability (`time.entries:A`, dimension-restricted to their crew/department). Policy publish: `exp.policy:K`.

## 9. AI dimension

| Feature | Gateway feature | Human gate |
|---|---|---|
| Receipt read and match | existing receipt categorize | employee confirms on the read-back; BK reviews exceptions |
| Policy compile | `EXPENSE_POLICY_EXTRACT` (exists) | reviewer publishes |
| Job suggestion for a charge | none: deterministic from the clock segment at charge time | employee confirms |
| Timesheet anomaly (missed punch, unusual OT, off-site pattern) | deterministic rules first; AI phrasing only | supervisor |
| Paystub explainer ("why is this check lower?") | phase 2, provider data only, NL over amounts | read-only |

## 10. Benchmark (Rule 14), named deltas

Web research for this session was exhausted on the vendor-compliance brief; the field-time benchmark below is from
general product knowledge and should be re-verified before the Projects FPB for time is approved.

| Product | Strength | Delta |
|---|---|---|
| **Gusto / ADP / Paylocity employee apps** | pay stubs, W-2, PTO | **Match** via provider; **beat** with job-costed pay ("billed to J-2614") and receipts in the same app |
| **Workyard / ClockShark / Busybusy** (field time) | job + cost code clock, geofence, crew punches | **Match** in Projects; **beat**: approved time flows to the ledger and job cost with no export |
| **Expensify / Ramp / Brex** | receipt capture, policy, reimbursements | **Match** capture and policy; **beat**: chase never stops until matched, and the policy is compiled from the company's own document with source sentences |
| **Homebase / When I Work** | schedule + clock for hourly | out of scope (scheduling is Projects' crews/dispatch) |

## 11. Data-model changes

**Suite Core (lead / shared spine):** `core.notification_channels` (user, channel, address, verified, consent_at,
stopped_at), `core.notification_log`, push subscriptions; role template `employee` (05 A-1).
**Projects (`1xxx` band, Projects workstream):** `proj.time_punches`; week submission + approval routing; non-job time
decision (§4.3); geofence radius on job site.
**Books (next Books migration per the lead):** `card_holders`, `receipt_policies` (M-11); M-7 tables if not landed;
`policy_acknowledgments` (org, location, policy_kind, policy_id, version, membership_id, acknowledged_at, method,
document_hash); `expense_policies.location_id`; `payroll.runs/run_lines` read view for the employee (own lines only,
security_invoker); **receipt chase switches**: `organizations.receipt_chase_enabled boolean not null default true`,
`company_policies.receipt_chase_enabled boolean null`; commission tables per docs/FPB-commissions.md §16 with an
employee read view (own statements and lines only, security_invoker).

## 12. Acceptance criteria

1. An employee invited by email signs in with a magic link on a 390 px phone and lands on Home in under 10 seconds;
   only entitled modules' cards render; no dead tiles.
2. Clock in at a job with a cost code, switch cost code, take a meal break, clock out: produces punches and segment time
   entries in Projects with correct durations; an off-site punch is recorded and flagged, not blocked.
3. Supervisor approves the week; payroll's run roster shows those approved hours with job/cost code; nothing unapproved
   is pulled.
4. Pay tab shows last net pay from `run_lines` and opens the stub from the provider; no SSN, account or routing number
   is stored or logged anywhere in Books or Core tables (schema guard test).
5. A card charge over the policy threshold sends a push within one scheduler cycle; quiet hours delay it; snapping the
   receipt matches it and stops the chase.
5a. With receipt chase **off** for the tenant, or for a client, no receipt request or reminder is sent for that
   client's charges, open reminders are cancelled, the Home card is hidden, and voluntary uploads still match.
   Turning it back on resumes only in-window requests (no burst). Every switch change is audited.
5b. An employee on a commission plan sees the current period's earned / clawback / net and per-job lines that match the
   approved statement to the cent; paid statements show the payroll date.
6. An expense line over a BLOCK limit can't be submitted without a reason; the reason routes it to the supervisor as an
   exception; WARN lines submit with a badge.
7. Publishing a new policy version creates acknowledgment tasks for every employee in scope; the controller sees
   "n of m acknowledged"; each ack stores version + document hash.
8. Policy upload: every proposed rule shows its source sentence; unmapped clauses are listed and never enforced;
   simulation on 90 days runs deterministically; publishing creates a new version and archives the old.
9. AI off: receipts store and wait for the BK; policy has a manual builder; nothing blocks the employee.
10. 390 px audit: every target ≥ 44 px, no horizontal scroll, AA contrast, visible focus, reduced motion respected.

## 13. Build sequence

1. Core: role `employee`, membership ↔ `core.employees` link, magic-link + passkey sign-in, notification channel service
   (email + push; SMS when INT-13 is picked). Shell PWA with Home composed from entitlement-gated cards.
2. Books: M-11 cards/cardholders + M-7 receipt chase (S21/S22), Receipts and Expenses tabs on mobile (APIs exist).
3. Books: policy upload upgrade (source spans, simulate, per-client publish) + acknowledgments.
4. Projects (parallel, its own FPB): punches, breaks, geofence, week submit/approve; then the Time tab.
5. Books + provider: Pay tab on the provider-agnostic seam — Gusto (API) first, file-based systems via register
   import + portal link; Commissions tab once the commission tables land (FPB-commissions §16).
5a. Books: receipt chase tenant/client switches (§4.9) with the M-7 sender.
6. Notifications digest, offline queue hardening, white-label theming.

## 14. Open decisions for the owner

| # | Decision | Default here |
|---|---|---|
| W1 | App identity | **DECIDED (owner):** "Merit Workforce"; employer logo/color inside; reseller rename later |
| W2 | Payroll provider | **DECIDED (owner):** provider-agnostic; Gusto first (API); any system via file import/export |
| W3 | Geofence on by default? | Off; per tenant; flag, never block |
| W4 | Reimburse via AP batch or payroll | AP batch default; payroll per tenant |
| W5 | Policy acknowledgment blocking expense submission | Flag only |
| W6 | Native app wrapper vs PWA | PWA first; wrap only if iOS push falls short |
| W7 | Non-job time in Projects (nullable job vs internal jobs) | Projects workstream decides |
| W8 | Receipt chase default for a NEW client when the tenant switch is on | Follow the tenant (null) |
| W9 | Show commission $ on the Home card or only inside the Pay tab (shared devices) | Home shows "View statement" only; amounts behind "Show" like pay |
