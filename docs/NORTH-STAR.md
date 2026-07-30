# MeritBooks — North Star

**Status:** The spine. Sits above the Feature Product Briefs. Every build should be
justifiable against this; if it isn't, question the build.
**Author:** Product/architecture session (Mike + Claude), 2026-07-29.

---

## 1. What MeritBooks is

MeritBooks is an **autonomous accounting workforce for multi-entity operators.**

The AI *does* the bookkeeping labor. The accounting staff *supervise the machine that
does it* — handling exceptions, judgment calls, and relationships. And a leader can
see, across the entire book of business, that it's being done right.

It serves the gap the market leaves open:

- **QuickBooks / Xero** — one business, one bookkeeper, manual. Not built for many
  entities, a team, or autonomy.
- **Sage Intacct / NetSuite** — heavy ERPs; six figures, months to implement, not
  AI-native, not built for a bookkeeping *operation* across many clients.
- **Bill.com / Ramp** — point solutions (AP, spend), not the whole book.

MeritBooks is for the operator who keeps the books of **many entities with a team**:
accounting firms, and multi-entity owners like Merit Management Group. It is
dual-sided — MeritBooks the product is itself run *by* a tenant (MMG), so the vendor
is its own first, hardest customer.

**The bet:** the winning product is not a better ledger. It is the one that *does the
work* and lets a leader *trust, at scale, that it's done right.*

---

## 2. The two sides of the system

### 2A. The processing side — the AI does the work

Autonomous pipelines. The system performs the task; a human touches only the
exceptions. Everything a bookkeeper does manually today is a pipeline:

- **AP ingestion** — read the payables inbox → extract vendor, amount, due date, job →
  post the bill → attach the source invoice to the transaction.
- **Vendor lifecycle** — new vendor on a new invoice → create it; then *chase the
  vendor* for COI, W-9, etc. (outbound + tracking, not just parsing).
- **Bank feed** — categorize every transaction.
- **Reconciliation** — run it.
- **Disbursement / check run** — tee up checks by due date → place them in the
  **check queue for approval** → pay on release.
- **Borrowing base** — read uploaded loan docs → produce the certificate.
- **Revenue recognition** — build and post the schedules.
- …and every other manual task, added as its own pipeline over time.

### 2B. The intelligence side — the AI thinks about the work and the business

- **Operations intelligence (supervising the machine):** machine-vs-human throughput,
  exception rate, accuracy / rework, backlog and aging, and *where a human should
  intervene* — the manager's flags.
- **Business intelligence (the numbers):** consolidated financials sliced any way
  (industry, division, ad-hoc), profitability, cash and forecast, and the health of
  the practice as a business.

Humans supervise **both** sides. The team's role shifts from *processing* to *running
the machine and owning judgment.*

---

## 3. The trust & control layer (non-negotiable)

Autonomy over financial data is only viable with control. This is the difference
between a demo and a system a lender-covenanted, audited business can run on. Every
pipeline is built on:

- **Confidence-tiered autonomy** — each action is *auto-done*, *queued for review*, or
  *escalated*, by confidence × risk. (The seed exists: bank-feed auto-approve at ≥85%
  confidence + trusted vendor + ≤ $10k.)
- **Full attribution + audit** — every entry records whether the *machine* or a
  *person* produced it, with the reasoning, and is reversible. "Who booked this and
  why" is a first-class answer for auditors and lenders.
- **Human-in-the-loop gates** — anything *outbound* (emailing a vendor), any
  *disbursement* (checks), and anything touching *debt covenants* (borrowing base)
  requires explicit approval. Always.
- **The exception queue is the human's home.** Staff live in "what did the machine
  flag for me," not "process this stack."
- **Standing controls** — period locks, approval limits, segregation of duties.

---

## 4. The people — roles invert

Access follows role; these are **overlapping lenses**, not silos (a manager keeps some
books *and* leads the team).

- **Reviewer / exception-handler** (was: the doer). Lives in the exception and approval
  queues for their assigned companies. The AI did the first pass; they judge the edges.
- **Manager / practice lead.** Supervises the machine + a lean team: portfolio health,
  intervention flags, allocation (who owns which companies), portfolio close. Can drop
  into any company's books and back. **This viewpoint is the wedge — and barely exists
  yet.**
- **Owner / CFO.** Consolidated truth across entities + the practice as a business.
  Also the buyer.
- **Client / business owner.** A light, read-mostly view of *their* entity's numbers.
- **Platform operator** (MeritBooks the vendor). Provision tenants, pricing,
  entitlements, fleet health. Needed to sell tenant #2.

---

## 5. Current state — honest

**Real:** tenant isolation enforced at the database (RLS), the book-of-record CRUD +
reporting pages, payments/fees end-to-end, the context-switcher shell, and *seeds* of
AI — bank-feed confidence scoring + the auto-approve rule, the AI Decision Log, receipt
and bill extraction.

**Scaffold / not real yet:** the autonomous pipelines (AP inbox ingestion, vendor
chase, reconciliation automation, the check run, borrowing base, rev-rec automation),
the intelligence/leadership dashboard, team management (no add-member), the platform
console.

**So:** the product is broad but shallow — the *pages* exist; the *engine* mostly
doesn't. The engine is the real product.

---

## 6. How it gets built into a leading system

**Principle:** the product is the **engine + the supervision/trust layer**; the UI is
how you run it. Build **depth-first, one pipeline at a time**, each taken all the way:

> ingest → AI acts → confidence-tiered *auto / review / escalate* → audited post →
> exception surface for the human.

Prove one pipeline end-to-end *and trustworthy* before starting the next. **Never fake
autonomy** — a pipeline that looks automated but hides manual work is worse than none.
**Real data only** — no invented metrics on the intelligence side.

### Sequence

0. **Foundation** — team management (invite → role → company access); action capture
   with machine-vs-human attribution; the trust primitives (confidence, action/audit
   log, approval gates).
1. **AP inbox → posted, attached, audited bill** — the highest manual-labor drain, and
   it exercises the entire trust pattern; includes vendor auto-create.
2. **Bank-feed autonomy** — mature the existing seed into categorize → auto/review/escalate.
3. **Check run** — due date → check queue → approval → disbursement.
4. **Reconciliation automation.**
5. **Vendor compliance chase** (COI / W-9) — outbound agentic + tracking.
6. **Rev rec automation; borrowing base from loan docs** (covenant-gated).
7. **Intelligence layer** — the supervision cockpit (exceptions, machine/human
   performance, flags), then consolidation + business intelligence.
8. **Platform console** — when onboarding tenant #2.

---

## 7. What "leading" requires (the moat)

- **Depth of automation across the full workflow**, not point solutions.
- **Trust** — audit, control, reversibility — so a covenanted, audited business can run
  on it. This is the hardest part and the deepest moat.
- **The leader's cockpit** — supervise the machine across the whole book of business.
- **Multi-entity & consolidation native**, not bolted on.

Anyone can build a bills list. Almost no one has built a system that *reliably does the
bookkeeping* and lets a leader trust it. That is the product.
