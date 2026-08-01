# Discovery Brief — The Accounting-Firm Partner (Practice Owner)

**Persona:** Partner/owner of an outsourced accounting & bookkeeping firm running the books
for 40+ client companies. This is the exact multi-client tenant MeritBooks targets — the
"Practice plane" in the canon (owned GL + autonomous accounting workforce + supervision/trust
layer + Merit-managed multi-client identity model).

**Grounding read:** `docs/canon/CANON-ANCHOR.md` (§1 owned GL / three pillars; §1.6 the product
is an autonomous accounting workforce staff *supervise*; §3 AI proposes → deterministic engine
posts → human approves; §2 generic multi-tenant, Merit is just a tenant).

**Purpose of this doc:** brief engineering on how a firm *actually operates* across many client
books, then translate that into the CONTROL / LEAK points an owned-ledger AI multi-tenant system
must solve. This is domain reality, not a feature request list — but every failure below is a
place the product either wins the practice or loses it. No application code.

---

## Part A — How a firm actually operates across many books

A single-company accounting tool models **one company's ledger**. A *practice* is a
**production business** whose product is *finished books, on time, at a defensible margin, across
a portfolio of clients*. The unit of work is not "a journal entry" — it's "Client X's month
closed and reviewed by the Nth business day." Everything below is about running that factory.

### A1. Staff / client assignment (the "book of business" grid)

- Every client is assigned a **preparer** (staff/senior doing the bookkeeping) and a **reviewer**
  (manager/partner who signs off). Larger clients add a controller layer. This preparer→reviewer→
  partner chain is the spine of quality and of segregation of duties.
- Assignments are a **grid**: staff on one axis, clients on the other, with a role in each cell.
  A partner needs to see the whole grid at a glance — who owns what, who is overloaded, who is a
  single point of failure.
- Clients are **tiered** (complexity/revenue/service level: e.g. monthly full-service vs.
  quarterly cleanup vs. annual). Tier drives who's assigned and how much time is budgeted.
- Assignments churn: staff leave, clients are re-assigned, someone covers a colleague on PTO. The
  system must make **re-assignment a first-class, audited action**, not a spreadsheet edit.

### A2. Capacity & utilization

- The firm sells **staff hours**. Capacity = billable hours available; the partner is constantly
  solving *does the work I've committed fit the people I have?* month over month.
- **Utilization** (billable ÷ available) is the top operational KPI per staffer. Too low = paying
  for idle time; too high (chronic overtime) = burnout and quality drops → errors → rework.
- Month-end is spiky: the close crunch lands the same days for every client. Capacity planning is
  really **peak-load planning** — leveling the close calendar so 40 clients don't all hit the 5th.
- New clients consume disproportionate capacity for the first 1–3 months (onboarding + cleanup)
  before settling into steady-state. Capacity models must treat onboarding as its own load.

### A3. Standardized close workflows (the "playbook")

- The firm's real IP is a **standardized monthly close checklist/playbook** applied to every
  client: bank/CC reconciliations, categorize/clear the feed, accruals, prepaids, depreciation,
  payroll JE, intercompany, revenue recognition, tie-outs, review, deliver financials.
- Each client has a **variant** of the standard playbook (client-specific steps: this one has a
  merchant-account reconciliation, that one a construction WIP schedule). Standard core +
  per-client deltas.
- The playbook enforces **sequence and dependencies** (can't review before reconciliations are
  done; can't close before the review passes). It's a workflow engine, not a static list.
- **Close cadence & targets**: books closed by business-day-N. The partner tracks *close velocity*
  across the whole portfolio: which clients are on-track / at-risk / late, right now.

### A4. Client onboarding & conversion

- Winning a client triggers a heavy, error-prone project: **collect access** (bank/CC/payroll/
  prior software), **convert historical data** (import from QBO/Sage/Xero/spreadsheets — in
  MeritBooks these are one-time migration sources, never a live layer), **set the opening trial
  balance**, rebuild the **chart of accounts** to the firm's standard, **clean up** prior-period
  messes, and agree the scope/engagement.
- Getting the **opening balances tied out** and the **first clean close** is the make-or-break
  moment; it's where realization is worst (huge hours) and where trust is won or lost.
- Onboarding is a **repeatable template** the firm wants to run identically every time — a
  standardized conversion playbook, not a bespoke scramble per client.

### A5. Client communication & document chase

- The firm's single biggest non-accounting time sink: **chasing clients for documents and
  answers** — missing receipts, "what was this $4,200 transfer for?", bank statements, loan docs,
  approvals on uncategorized items. Nothing closes until the client responds.
- Every client relationship has an **open-questions list** and a **document-request list** that
  must be tracked *per client* and nagged automatically. Uncategorized/unknown transactions are
  the recurring stall point.
- Communication is **portal + email**: a client-facing surface where clients see what's owed,
  upload docs, answer questions, and view/approve deliverables. Without a portal, this lives in
  a partner's inbox and is invisible and unmanaged.

### A6. Review / approval hierarchy

- **Preparer does the work → reviewer checks it → partner signs off.** Review is where quality is
  enforced and where the **bottleneck** almost always sits (few reviewers, many preparers).
- Review produces **review notes / points** the preparer must clear before sign-off — an iterative
  loop that must be tracked, not lost in verbal back-and-forth.
- Sign-off is the gate to **deliver financials** to the client. Segregation of duties: the person
  who prepares/posts is not the person who approves — directly mirrors the canon's
  *AI proposes → human approves* and *preparer ≠ approver* invariants (§3), just with the AI as an
  additional "preparer" that must also be supervised.

### A7. Realization & write-downs

- **Realization** = collected revenue ÷ standard value of hours worked. If a client is a fixed
  monthly fee but eats 2× the budgeted hours, realization craters — the firm ate the overage.
- **Write-downs / write-offs**: hours worked that won't be billed (over-budget, scope the firm
  swallowed, inefficiency). Tracked per client and per staffer; a leading indicator of a bad
  engagement or a struggling staffer.
- The partner needs **per-client profitability**: fee vs. fully-loaded cost of hours delivered.
  Some clients are quietly unprofitable and nobody notices until year-end (if ever).

### A8. Quality control

- Consistency across 40 books: same COA discipline, same close standard, same reconciliation
  rigor, regardless of which staffer did it. QC = periodic internal review, exception monitoring,
  tie-out checks, and catching a preparer who's drifting.
- Errors caught **after** delivery are the expensive ones — restated financials, lost client trust,
  redone work (a write-down and a relationship hit at once).
- QC wants **exception surfaces**: unreconciled items, stale uncleared transactions, out-of-balance
  intercompany, negative balances that shouldn't be, month-over-month anomalies — across all
  clients at once.

### A9. Pricing

- Mix of **fixed monthly fee** (most common in outsourced bookkeeping), hourly, and value/tiered
  pricing. Fixed fee is where realization risk lives — the firm bears the overage.
- Pricing is set at onboarding against an **estimated hours model** and is sticky; it rarely gets
  re-priced even as a client's volume/complexity grows → **scope creep silently erodes margin**.
- The partner needs to periodically re-test *fee vs. actual hours* per client and re-price or
  re-scope the losers.

---

## Part B — CONTROL / LEAK points an owned-ledger AI multi-tenant system must solve

Each item: **the failure prevented · the $/risk · the trigger/data · the human-in-loop posture.**
"Human-in-loop" is written to match the canon: the AI surfaces and proposes; a human decides on
anything that moves money, changes the book, or touches a client relationship.

### B1. Work not done on time across clients (portfolio close tracking)
- **Failure prevented:** a client's books silently slip past the committed close date; the partner
  finds out when the client complains. At 40 clients, "who's late right now?" is unanswerable
  without a system.
- **$/risk:** SLA breaches, lost clients (churn on a $2k–$10k/mo recurring fee), emergency
  overtime to catch up, reputational damage that kills referrals.
- **Trigger/data:** per-client close playbook state vs. calendar (business-day-N targets); % steps
  complete; blocked-on-client flags; days-to-deadline. Roll up to a **portfolio close board**
  (on-track / at-risk / late).
- **Human-in-loop:** system flags and forecasts slippage autonomously; **partner decides** re-
  assignment, escalation, or client comms. AI can draft the nudge, human sends it.

### B2. No cross-client status visibility (the practice dashboard)
- **Failure prevented:** the partner has no single pane of "state of the practice" — status lives
  in 40 separate ledgers and people's heads. This is the #1 thing a single-company tool structurally
  cannot provide.
- **$/risk:** decisions made blind; problems compound before they're seen; partner time wasted
  polling staff for status.
- **Trigger/data:** aggregate every client's close state, open items, review status, exceptions,
  and profitability into **one cross-client dashboard**. This is the practice plane's core screen.
- **Human-in-loop:** pure visibility layer; no approval needed to *see*. Drill-down from portfolio →
  client → task. The dashboard is authoritative because it reads live ledger state, not manual
  status entry.

### B3. Review bottlenecks
- **Failure prevented:** work piles up unreviewed because reviewers are the scarce resource; either
  the close stalls or things ship un-reviewed (quality risk).
- **$/risk:** late closes, or errors delivered → restatements + write-downs. Reviewer burnout →
  key-person risk.
- **Trigger/data:** count/age of items awaiting review per reviewer; review queue depth; time-in-
  review; which preparers generate the most review points (a QC + training signal).
- **Human-in-loop:** AI can **pre-review** — auto-tie-outs, flag anomalies, clear the mechanical
  checks so the human reviewer only looks at judgment items — collapsing review time. Sign-off
  stays human (canon §3/§4). This is the highest-leverage AI insertion point in the practice.

### B4. Inconsistent close quality across staff/clients
- **Failure prevented:** every staffer closes "their way"; quality depends on who did it; a weak
  staffer's clients drift.
- **$/risk:** errors, rework/write-downs, client trust, audit exposure on the book of record.
- **Trigger/data:** enforce the **standardized playbook** so every close runs the same required
  steps/gates; measure completion + exceptions uniformly; compare quality metrics across staff.
- **Human-in-loop:** the playbook is enforced software (can't skip a required reconciliation);
  AI executes the mechanical steps consistently; humans handle judgment. Consistency comes from the
  machine doing the repeatable labor, per the "autonomous workforce" thesis.

### B5. Client-document / receipt / answer chasing
- **Failure prevented:** closes stall waiting on the client; the chase is manual, invisible, and
  forgotten until it's late.
- **$/risk:** every stalled close is capacity locked up and a deadline at risk; chase labor is pure
  non-billable overhead (a realization drain).
- **Trigger/data:** uncategorized/unknown transactions and missing-doc conditions auto-generate a
  **per-client open-items list**; **client portal** shows the client exactly what's needed;
  automated, escalating reminders.
- **Human-in-loop:** AI detects the gap, drafts the request, and auto-nudges on a cadence;
  **client responds** in the portal; staff only touch exceptions. Anything the AI is unsure how to
  categorize becomes a portal question, never a silent guess.

### B6. Staff utilization vs. realization (are we busy AND profitable?)
- **Failure prevented:** conflating "busy" with "profitable." A staffer can be 100% utilized on
  clients that are all write-downs. The partner needs both dials together.
- **$/risk:** the firm's margin. Chronic low realization on a client = an unprofitable engagement;
  chronic overtime = burnout → turnover (the most expensive event a firm has).
- **Trigger/data:** hours (budgeted vs. actual) per client and per staffer; utilization; realization
  = fee ÷ standard value of hours; write-down $ and trend.
- **Human-in-loop:** analytics + alerts; **partner decides** re-pricing, re-scoping, re-staffing, or
  firing a client. In an *owned-ledger AI* system, the AI doing the manual labor is what structurally
  improves realization — fewer human hours per close at the same fee.

### B7. Scope creep (silent margin erosion on fixed-fee clients)
- **Failure prevented:** a fixed-fee client's volume/complexity grows; nobody re-prices; the firm
  quietly does more work for the same money.
- **$/risk:** margin bleed that's invisible until a year-end profitability review — if the firm even
  does one.
- **Trigger/data:** transaction volume, entity count, hours, and exception count vs. the onboarding
  baseline the fee was priced on; flag clients whose actuals have outgrown their tier/fee.
- **Human-in-loop:** system flags scope drift and quantifies it; **partner has the re-price/re-scope
  conversation**. AI can assemble the evidence pack for that conversation.

### B8. Key-person risk
- **Failure prevented:** one staffer holds all the knowledge/relationship for a set of clients; they
  leave and the books are orphaned.
- **$/risk:** at-risk revenue on those clients; scramble/overtime to cover; possible client loss.
- **Trigger/data:** the **assignment grid** exposes concentration (client coverage by a single
  person, no backup reviewer); standardized playbooks + documented state mean anyone can pick up a
  client mid-close.
- **Human-in-loop:** the system makes concentration visible and makes hand-off *possible* (state
  lives in the platform, not the person's head); **partner** assigns backups and re-balances.

### B9. Per-client profitability
- **Failure prevented:** not knowing which clients make money. Some 40-client books have a handful of
  quiet money-losers subsidized by the rest.
- **$/risk:** the difference between a healthy firm and a treadmill; misallocated best staff on the
  worst-margin clients.
- **Trigger/data:** fee (recurring + one-off) vs. fully-loaded cost of hours delivered, per client,
  per month; ranked. This is a *practice-level* P&L that sits above the client ledgers.
- **Human-in-loop:** reporting + ranking; **partner acts** (re-price / re-scope / fire / re-staff).

### B10. Onboarding / conversion risk (bonus, high-stakes)
- **Failure prevented:** a botched conversion — wrong opening balances, a mangled COA, an untied
  first close — poisons a client relationship from day one and buries hours.
- **$/risk:** worst-realization phase of any engagement; the moment most likely to lose a
  just-won client.
- **Trigger/data:** a standardized **onboarding playbook** with gated steps (access collected →
  historical import from QBO/Sage as a *one-time source* → opening TB tied out → COA mapped → first
  clean close); AI-assisted categorization of the historical mess.
- **Human-in-loop:** AI does the bulk import/categorization and proposes the opening TB; **staff/
  partner tie out and approve** before the client is "live." Nothing posts to the owned GL without a
  human blessing the opening position.

---

## Part C — What a PRACTICE needs that a single-company tool structurally lacks

A single-company book of record answers *"what is this one company's financial position?"* A
practice needs a whole plane **above** the ledgers:

1. **Cross-client / portfolio dashboards** — one pane over all 40 books: close status, exceptions,
   review queues, profitability, deadlines. A single-company tool has no concept of "all my clients."
2. **Staff ↔ client assignment model** — the grid: who prepares, who reviews, who's the partner, per
   client; tiers; re-assignment; concentration/key-person visibility. Single-company tools model
   *one* company's users, not a firm's workforce spanning many companies.
3. **Standardized, enforceable playbooks** — the firm's close/onboarding IP applied identically to
   every client, with per-client variants, sequencing, and gates. Single-company tools have at most a
   static checklist for themselves.
4. **Client portals** — a client-facing surface for document upload, open-question answers,
   deliverable review/approval, and status. The firm is a *service business*; the portal is the
   service boundary. A single-company tool has no "our clients" notion at all.
5. **Practice economics** — utilization, realization, write-downs, per-client profitability, capacity
   planning across the portfolio. This is the firm's own P&L *about* doing the client work — a layer
   that simply doesn't exist in a one-company product.
6. **Practice-level identity & scoping** — one firm-user securely acting across many client tenants
   with correct RLS/isolation per client, but a unified home. This is exactly the canon's
   **Merit-managed multi-client identity model**: the practice as an actor over many tenants, without
   leaking one client's data into another.

---

## Part D — Common-core vs. practice-specific (build-boundary guidance)

**Common core (every tenant, incl. a single self-serve company — Books/Suite Core):**
- The owned GL, double-entry engine, posting rules, period locks (canon §3).
- Bank/CC feed ingestion + AI categorization (AI proposes → human approves).
- Reconciliations, close checklist *for one company*, financial statements / FP&A.
- AR/AP, invoicing, money movement — the actual accounting work on one book.
- Per-tenant COA template, dimensions, rev-rec, audit/decision log.
- **Identity primitives** (`core.users/memberships/roles`) that everything scopes to.

**Practice-specific (the Practice plane — only a firm tenant sees these):**
- Cross-client portfolio dashboard & close board (aggregation over many tenants).
- Staff↔client assignment grid, tiers, capacity/utilization, re-assignment.
- Firm-standard playbook library + per-client variants + enforcement/gating.
- Review-queue management, review notes/points, preparer→reviewer→partner routing *as a firm role*.
- Client portal (doc requests, open questions, deliverable approval, status).
- Practice economics: realization, write-downs, per-client profitability, pricing/scope-creep
  monitoring.
- Onboarding/conversion pipeline as a repeatable, gated project template.
- **Practice identity**: one firm-user acting across N client tenants with per-tenant RLS isolation
  (the multi-client identity model), plus firm-vs-client role separation.

**Design consequence:** the practice plane is *not* a bigger single-company tool — it's an
orchestration/supervision layer whose "workers" are (a) the AI accounting workforce doing the
labor inside each client's owned ledger and (b) the firm's human staff supervising and approving.
Everything in Part B is a **control surface for that supervision layer**. Build the common core so
it emits the state (close %, exceptions, hours, review status, open items) that the practice plane
aggregates — the practice dashboards are only as real as the live ledger signals feeding them, and
should never be manual status entry (that would violate the "demonstrated, not asserted" standard).

---

## Appendix — Canon alignment checklist for the practice plane

- Owned GL, not a QBO/Sage automation layer; those are one-time conversion sources. ✔ (§1, A4/B10)
- AI proposes facts → deterministic engine posts → human approves; auto-post off by default;
  autonomy is a per-tenant, per-task dial. ✔ — the practice plane is the *supervision* surface for
  exactly this. (§3)
- Preparer ≠ approver; segregation of duties reconciled to `core.memberships/roles`. ✔ — the firm's
  review hierarchy IS this control, and the AI counts as a "preparer" to be supervised. (§3, A6/B3)
- Generic/white-label: model a *firm* and *tiers* generically; never hardcode one firm's structure.
  ✔ (§2)
- Multi-tenant RLS isolation per client, with a practice identity acting across tenants. ✔ (§2, C6)
- "Complete is demonstrated, not asserted": practice dashboards must read live ledger state, not
  manually-typed status. ✔ (§4/§5, B2)
