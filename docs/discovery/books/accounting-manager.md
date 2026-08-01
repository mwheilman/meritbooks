# Discovery — The Accounting/Bookkeeping Manager

**Persona:** 15+ years in the seat. I run a team of bookkeepers/staff accountants (processors) across a
book of clients (or, inside one company, a set of entities/portfolio companies). I am the human who is
**accountable** — when the CFO or client opens the financials, my name is on the accuracy and the timing.
I am the person MeritBooks means by *"staff supervise the machine; leaders verify it's done right"*
(CANON-ANCHOR §1). This doc is written for the engineering team: first how I actually manage the work
today, then the supervision/control surface an **owned-ledger** AI system has to give me — because the
machine now IS most of my processing team, and my job shifts from *doing* to *supervising and signing off.*

Ground truth I'm building on (from `docs/canon/CANON-ANCHOR.md`): MeritBooks **owns the GL**; the product
is an **autonomous accounting workforce + a supervision/trust layer**; **AI proposes facts, a deterministic
engine posts, a human approves; auto-post is OFF by default and autonomy is a per-tenant, per-task dial**;
there is an `/exceptions` queue; `core.action_log` / `audit_log` carry **machine-vs-human attribution**; and
there are **confidence tiers**. Everything below is anchored to those facts.

---

## PART A — HOW I ACTUALLY MANAGE THE WORK TODAY

This is the operational reality the system is replacing/augmenting. If the software doesn't reproduce these
control instincts, it will feel like flying blind, and I won't sign the close.

### A1. Assigning the work
- I don't assign by "task," I assign by **book of responsibility**: this processor owns these entities/clients,
  these bank accounts, this AR desk. Ownership creates accountability and pattern familiarity — the person who
  reconciles Heritage every month is the one who *notices* when Heritage looks wrong.
- I **level the assignment to the person**: junior staff get high-volume, low-judgment work (bank feed coding
  against clean rules, straightforward AP entry). Seniors get judgment work (accruals, revenue cut-off,
  intercompany, anything touching an estimate). I never let a junior book a management estimate unreviewed.
- I load-balance against **capacity and the calendar**: close week, payroll dates, tax deadlines, a client
  going through diligence — all bend who gets what. I keep a mental (and spreadsheet) model of "who has room."
- I keep **continuity**: same preparer month over month, because the value is in the memory, not the keystrokes.

### A2. Reviewing the work / catching errors before they reach the client or CFO
This is the core of the job. The error must die at my desk, not on the CFO's screen. My review layers:
- **Preparer self-review, then my review** — nothing goes to the client that a second set of eyes didn't touch.
- **The reconciliation is the gate.** If cash, AR, AP, payroll clearing, and credit-card liability don't tie to
  the statement/sub-ledger, nothing downstream is trustworthy. **Unreconciled = not done**, full stop. I look at
  the reconciling items, not just the "difference = 0."
- **Analytical review (the sniff test).** Flux/variance vs prior month and budget. A number that moved 40% with
  no story is a question, not a fact. Margins that drift, an expense line that's suddenly empty, revenue booked
  in the wrong period — I catch these by *shape*, before I ever check a single entry.
- **Known error patterns I hunt for:** duplicate bills/payments, wrong period (cut-off), wrong entity
  (intercompany miscoded), expense vs. capitalization, a payment re-expensed instead of clearing the liability
  (DR AP / CR cash — not DR expense again; this is CANON §3), sales tax/withholding mis-splits, a plug someone
  used to force a reconciliation instead of finding the real item.
- **Support/documentation.** No journal entry without a reason and backup. "Because the balance was off" is not a
  reason. I want the *why*, attached.
- **Materiality-scaled scrutiny.** I do not review every $12 coffee charge with the same intensity as a $180k
  accrual. I spend my attention where the dollars and the judgment are. Below a threshold, I trust the rule.

### A3. Knowing what's behind (status / "where is everything")
- I run a **close calendar / status board**: for every entity and every workstream (bank rec, AR, AP, payroll,
  accruals, intercompany, review, sign-off), what state is it in — not started / in progress / ready for review /
  reviewed / done. Today this is often a spreadsheet or a checklist app, and it's always a little stale.
- I run a **daily standup / desk-check**: what's stuck, what's waiting on a client (missing statement, unanswered
  vendor question), what's at risk of missing the deadline.
- **Aging is my early warning.** Open items aging up — unreconciled transactions, uncategorized bank lines,
  unapplied cash, an AR/AP sub-ledger that won't tie — tell me a desk is falling behind *before* the deadline does.
- The thing I most lack today: a **real-time, single-pane view of where every entity is in the close.** I
  assemble it manually by pinging people. It's the #1 thing I'd want automated.

### A4. Deciding where to intervene
- I triage by **risk × dollars × judgment**, not by volume. I intervene on: anything touching cash movement,
  anything with an estimate/accrual, anything intercompany/consolidation, anything a junior touched for the first
  time, anything the analytics flagged, anything a client is sensitive about.
- I **trust the routine and inspect the exceptions.** If a rule has coded a recurring vendor correctly 300 times,
  I'm not re-checking #301 — I'm checking the one that *didn't* match the pattern.
- I escalate up (to controller/CFO/client) when it's a **policy or judgment call above my authority**: a new
  revenue-recognition treatment, a reserve, a related-party question, a covenant-relevant classification.

### A5. Training staff
- **Review-as-teaching:** I don't silently fix a junior's error — I mark it, explain the principle, and make them
  redo it. The correction is the curriculum. Repeated errors from one person are a training signal, not a
  discipline signal (usually).
- I watch **error rate and error *type* per person over time**. Someone whose errors are shrinking is growing;
  someone making the same cut-off mistake three months running needs a targeted lesson.
- I build **playbooks / SOPs** for recurring work so the standard is the standard, not one person's habit.

### A6. Enforcing separation of duties (SoD)
- The person who **enters** a bill is not the person who **approves** it is not the person who **releases the
  payment**. Preparer ≠ approver ≠ payer. This is non-negotiable on anything that moves money.
- Bank/payment credentials are held tightly; no processor both creates a vendor *and* pays that vendor.
- Master-data changes (new vendor, changed bank account on a vendor — the classic fraud vector) get a second
  approval. A changed vendor bank account is treated as high-risk by default.
- I keep the **audit trail** so that after the fact I (or an auditor) can prove who did what and who approved it.

### A7. Signing off on the close
- I don't sign until: **every account is reconciled**, reconciling items are explained, accruals/cut-off are in,
  intercompany eliminates and consolidation ties, the flux review has a story for every material move, all
  review notes are cleared, and the period is ready to **lock**.
- Sign-off is **personal accountability**: I am attesting these books are right. After sign-off, the period is
  **locked** — no back-dated edits without a documented, approved reopening. An unexplained change to a closed
  period is a red-alert control failure.

---

## PART B — THE SUPERVISION / CONTROL SURFACE AN OWNED-LEDGER AI SYSTEM MUST GIVE ME

Now the machine does the processing. My team is partly (eventually mostly) software. **My job does not shrink —
it changes from doing to supervising.** For that to be safe, the system has to externalize the control instincts
in Part A into a real supervision layer. For each control I give: **what it prevents · the trigger/data behind it ·
the human-in-the-loop / override posture.** These map onto the canon's `/exceptions` queue, `action_log`
attribution, confidence tiers, and the per-task autonomy dial.

### B1. Real-time close command center — "where is every client/entity right now"
- **What it prevents:** the deadline surprise; discovering on day 5 that entity 12's bank rec never started;
  me having to ping people to assemble status. Replaces the stale spreadsheet in A3.
- **Trigger/data:** live per-entity × per-workstream state machine (bank rec, AR, AP, payroll, accruals,
  intercompany, review, sign-off) driven off actual ledger/reconciliation/queue state — not a manually updated
  checklist. Shows % complete, what's blocking, what's waiting on a client, what's at risk vs. the close calendar,
  and **who/what owns each cell (machine vs. named human).**
- **Human posture:** read-first situational awareness; I click into any red cell to intervene, reassign, or push.
  The board is the truth, because it's derived from the system, not typed by a person.

### B2. Machine-vs-human work attribution (the `action_log` made legible)
- **What it prevents:** not knowing what the AI did on its own vs. what a person did; the audit nightmare of
  "the computer did it"; being unable to prove segregation of duties when part of the "staff" is software.
- **Trigger/data:** every action written to `core.action_log` / `audit_log` with actor = **specific human OR
  specific AI agent/model+version**, timestamp, what it touched, and the confidence/reason. (Canon note: because
  `gl_entries.created_by/posted_by` are uuid-nullable and AI writes null there, the human/machine identity MUST
  live in the action/audit log — engineering, this is load-bearing for me.)
- **Human posture:** I can filter any period, entity, or account by "show me everything the machine posted
  autonomously," "show me everything a human overrode," "show me what agent X did." This is how I supervise a
  workforce I can't see working.

### B3. Confidence-tiered review queue (surface only what needs a human)
- **What it prevents:** two opposite failures — (a) reviewing everything (defeats the automation, I drown) and
  (b) reviewing nothing (errors reach the CFO). It reproduces my A2/A4 instinct: **trust the routine, inspect the
  exceptions.**
- **Trigger/data:** AI attaches a confidence to every proposed fact/categorization; tiers route it. My starting
  posture (tunable): **high-confidence + trusted pattern + under a dollar threshold → auto-handled, sampled;
  medium → my review queue; low or anomalous → hard stop, blocked from posting.** (The bank-feed rule in CLAUDE.md
  — ≥90% auto, 70–89% review, <70% flag; auto-approve only if ≥85% AND trusted vendor AND ≤ $10k — is exactly the
  shape I want, generalized to every workstream.) Queue is sorted **lowest-confidence / highest-risk first** so my
  attention goes where it's needed.
- **Human posture:** the tiers are **my dials, not fixed constants.** I set thresholds per task, per entity, and
  I can only *loosen* them after the machine has earned it (see B9/B10). Every auto-handled item stays
  **sampleable** — I can always pull a random audit sample from the "trusted" band to confirm the machine is still
  right. Nothing in a tier is invisible to me; "auto" means "done without asking," never "hidden."

### B4. Anomaly / error flags BEFORE posting (pre-post controls)
- **What it prevents:** the error entering the book of record at all. In an *owned* ledger this matters more than
  in a bolt-on tool — there's no upstream system to blame or reconcile against; MeritBooks IS the truth. Catch it
  at proposal time, not in next month's flux.
- **Trigger/data:** run my A2 error-hunt as automated pre-post checks — duplicate bill/payment detection, wrong-
  period/cut-off flags, intercompany/wrong-entity mismatch, expense-vs-capitalize, **re-expensed settlement**
  detection (DR expense where it should DR AP/clear the CC liability — CANON §3), unusual amount/vendor/account
  vs. history, round-dollar/threshold-nudge patterns, and the deterministic engine's own gates (balance,
  period-lock, COA approval, control accounts, dimension validation). Anything anomalous is held.
- **Human posture:** hard flags **block auto-post and route to me with the reason**; soft flags post but annotate.
  The deterministic engine already guarantees debits=credits and respects locks (CANON §3) — that's the floor.
  These anomaly flags are the *judgment* layer on top, and they must fail **closed**: uncertain → don't post,
  ask me.

### B5. Workload / capacity view (of the machine AND the humans)
- **What it prevents:** silent backlog; the exception queue quietly growing until it's a wall; over-reliance on
  the one senior who's actually clearing everything; me not knowing we're underwater until the deadline.
- **Trigger/data:** live counts and aging of the exception/review queue by entity, workstream, tier, and assignee
  (human or agent); throughput (items cleared/day) vs. inflow; projected time-to-clear against the close calendar.
  This is A3's "aging as early warning" turned into a dashboard.
- **Human posture:** I reassign, re-tier (temporarily raise auto-thresholds under deadline pressure — a conscious,
  logged risk decision), pull in help, or push a deadline. The system should **warn me when the queue is growing
  faster than it's being cleared** — that's the trigger to act.

### B6. Approval + separation-of-duties enforcement (A6 in software)
- **What it prevents:** the same actor preparing and approving and paying; fraud via master-data change; the AI
  approving its own work. In a system where the AI is the preparer, **SoD must apply to the AI itself** (CANON §3
  says exactly this).
- **Trigger/data:** enforced preparer ≠ approver ≠ releaser on anything that moves money, with the DB CHECK +
  service already contemplated (CANON §3). AI can be the *preparer*; a **human release** is explicit for money
  movement; approval authority reconciles to **Core identity (`core.memberships/roles`)**, not a Books-private
  role table. (Engineering flag straight from canon: the current `canApprove` reading `core.employees.role` is a
  **stopgap** to be reconciled — I care about this because my SoD guarantee is only as good as the identity it's
  keyed to.) High-risk master-data changes (vendor bank account) require second approval.
- **Human posture:** approvals are human and non-delegable-to-the-AI for money movement; the system enforces the
  wall and won't let me (or a processor) collapse the roles even by accident.

### B7. The audit trail that proves who/what did what (A7's evidence)
- **What it prevents:** an unprovable close; not being able to answer an auditor, a lender in diligence, or the
  CFO's "who booked this and why"; undetected back-dated edits to a locked period.
- **Trigger/data:** immutable, append-only `audit_log` / `action_log` — actor (human or AI+version), timestamp,
  before/after, reason/support link, approval chain; period-lock events and any reopen (who authorized, why).
- **Human posture:** read-only to everyone; I can reconstruct the full life of any number on demand. This is what
  lets me *sign* — I'm attesting on top of a provable record, not a vibe.

### B8. Autonomy-rate & exception-backlog metrics (is the machine actually earning trust)
- **What it prevents:** flying blind on whether autonomy is helping or hurting; creeping error; not noticing the
  machine degraded after a model change or a new client onboarded.
- **Trigger/data:** **autonomy rate** (% of volume handled without a human touch), **exception/override rate**
  (how often humans had to correct the machine), **error-caught-pre-post vs. escaped-to-review vs. escaped-to-
  close**, backlog size and aging, and rework rate — sliced by entity, workstream, and confidence tier, trended
  over time. This is A5's "error rate per person" applied to the machine.
- **Human posture:** these metrics *govern the dials.* Autonomy rate rising **while** override/error rate stays
  low and stable = I earn the right to loosen tiers (B3). Override/error rate rising = I tighten, and investigate.
  The metrics are the feedback loop of the whole trust layer.

### B9. WHAT A SUPERVISOR NEEDS TO TRUST AN AUTONOMOUS WORKFORCE
This is the crux. I will not sign a close I can't stand behind. To trust the machine like I trust a seasoned
senior, I need:
1. **Transparency of reasoning.** Every AI action shows its *why* and its confidence, in accounting terms I can
   audit — not a black box. "I coded this to 6100 because vendor X's last 12 invoices went there and the memo
   says 'monthly service'." I can accept or reject the reasoning, not just the answer.
2. **Calibrated confidence.** When it says 95%, it must actually be right ~95% of the time. A miscalibrated
   confidence score is worse than none, because it corrupts my tiering. I verify calibration via B8 over time.
3. **A demonstrated track record, earned gradually.** Trust is *built*, not defaulted. The canon's **auto-post
   OFF by default, per-task autonomy dial** is exactly right: start the machine in "propose, human approves,"
   watch the override rate on that task fall to near-zero over enough volume, *then* let it auto-post that task.
   Autonomy is granted per task/entity as evidence accrues — never flipped on globally.
4. **Fail-closed behavior.** On uncertainty, ambiguity, missing support, or an anomaly, the machine **stops and
   asks**, it does not guess-and-post. I trust a system that says "I'm not sure" far more than one that's
   confidently wrong. This must be the default, not a setting.
5. **Deterministic accounting.** The judgment (what account, what period, is this a duplicate) can be AI; the
   **accounting mechanics must be deterministic** — debits=credits, direction from account type, settlements
   clear liabilities, period locks hold (CANON §3). I trust "AI proposes facts, engine does the accounting"
   precisely because the machine can't invent a debit.
6. **Reversibility and containment.** Every machine action is traceable and correctable; nothing the AI does is
   irreversible without a human gate (money movement especially). A mistake is recoverable, not catastrophic.
7. **Sampling rights.** Even in the trusted band, I can always pull a random sample and check. Trust that can't
   be spot-audited isn't trust, it's hope.
8. **Stable behavior across changes.** When the model/version changes or a new entity onboards, I'm told, and
   the metrics are watched for regression. A silent model swap that quietly changes coding behavior is a
   trust-breaker.

### B10. WHAT WOULD MAKE ME TURN IT OFF (kill-switch triggers)
I need a **kill switch / autonomy throttle** — per task, per entity, and global — and clear conditions for using it:
- **Override/error rate spikes** on a task or entity (the machine started being wrong) → drop that task back to
  "propose-only," investigate.
- **A material error reaches the close** (escaped every gate) → immediate throttle-down + root cause; one escaped
  material error costs more trust than a thousand correct auto-posts earned.
- **Miscalibrated confidence** — it's confidently wrong — → I can't trust the tiers, so I tighten everything.
- **Anomalous behavior after a model/version change** → freeze autonomy until re-verified.
- **SoD or audit-trail integrity failure** — the wall was breached, or the log is incomplete/mutable → hard stop;
  a book of record I can't prove is worthless, and I won't sign it.
- **Backlog the machine can't clear** faster than it grows, hiding real work → surfaces via B5; may mean pulling
  humans back in.
- **My own gut on a close** — if the flux doesn't tell a coherent story and I can't get comfortable, I have the
  authority to halt sign-off and force human review regardless of what the confidence scores say. The human
  supervisor's judgment is the final gate, always. The system must never be able to close a period over my
  objection.

**Design mandate for engineering:** the throttle must be *my* control, act **immediately**, be **granular**
(task/entity/global), and **degrade gracefully** — turning autonomy off drops the machine to "propose, human
approves," it does **not** stop the books. The floor is always a supervised manual process, never a dead system.

---

## PART C — COMMON-CORE vs. SEGMENT

MeritBooks is a **generic, white-label platform** (Merit is just tenant #1 — CANON §1). The supervision layer
must be **common core**, with **segment configuration**, not segment-specific rebuilds.

### Common core (every tenant, every segment — build once)
- The close command center / status board (B1); machine-vs-human attribution (B2); confidence-tiered queue and
  the per-task autonomy dial (B3); pre-post anomaly/error gates and the deterministic engine gates (B4);
  workload/capacity view (B5); preparer≠approver≠releaser SoD keyed to Core identity (B6); immutable audit trail
  + period lock/reopen (B7); autonomy-rate & exception-backlog metrics (B8); the kill-switch/throttle (B10); and
  the trust primitives in B9 — transparency, calibration, earned-autonomy, fail-closed, reversibility, sampling.
  **None of this is industry-specific.** Every book of record, in every vertical, needs exactly these controls.
  This is the moat: the supervision/trust layer is the product.

### Segment configuration (tune the common core; don't fork it)
These vary by industry/tenant and should be **config, thresholds, rules, and templates over the same engine** —
never bespoke code paths:
- **Materiality thresholds & auto-post dollar limits** — a construction holdco and a SaaS startup and a nonprofit
  draw the line in very different places.
- **Chart of accounts & coding rules** — COA is **per-tenant** (CANON §2); the categorization rules and trusted-
  vendor lists are tenant/segment data feeding the same confidence engine.
- **Revenue-recognition method** — method-per-job, Books-owned, 9 methods (CANON §3); construction/percentage-of-
  completion vs. subscription/ratable vs. point-in-time. Same rev-rec engine, segment-selected method; changes
  *which* anomaly checks (cut-off, deferred-revenue vs. revenue) matter most.
- **Close calendar, workstreams & close checklist** — which workstreams exist and their deadlines
  (e.g. job-cost close and intercompany eliminations matter for a multi-entity holdco like Merit; sales-tax
  workstreams matter for retail; grant/fund accounting for nonprofits).
- **Multi-entity / consolidation** — intercompany elimination and consolidation (CANON §5 marks 11a MANDATORY,
  top priority) is a *configured* capability the status board and anomaly checks light up when a tenant has
  multiple entities; a single-entity tenant simply doesn't see those cells.
- **Approval hierarchy & authority limits** — who can approve what dollar amount maps to the tenant's org and
  Core roles/memberships; the SoD *engine* is common, the *thresholds and role map* are segment/tenant.
- **Regulatory/compliance overlays** — sales tax, 1099/withholding, fund/grant restrictions, industry audit
  requirements — as pluggable rule packs feeding the same pre-post gate and audit trail.

**Rule of thumb for engineering:** if it's a *control mechanism* (a gate, a queue, an attribution, a metric, a
throttle) it's **core**; if it's a *value in that mechanism* (a threshold, a rule, a method choice, a role map, a
workstream list) it's **segment/tenant config.** Build the mechanisms once, make every value configurable, and
the same supervision layer serves a plumbing holdco and a software company without a fork.
