# Feature Product Brief — Team Performance / Bookkeeper Productivity Dashboard

**Module working name:** Team Performance (a.k.a. Workforce Analytics / Bookkeeper Scorecards)
**Author:** Auditor (Rule 13 FPB authorship)
**Date:** 2026-08-01 (Session 41)
**Status:** SPEC ONLY — no application code. Written before build, per CANON §4 (Rules 13–16).
**Fills the owner's named gap:** the Team & Access console shows *who can do what* but **NO indicator of
how anyone is actually performing** — no throughput, no latency, no quality, no "who's behind." This FPB
specifies the objective, anti-gameable performance layer that closes that gap.

---

## §0. Scope, grounding, and canon reconciliation

**Grounding read (done before writing):** `docs/canon/CANON-ANCHOR.md` (trust layer, `core.action_log`
machine-vs-human attribution, confidence tiers, per-task autonomy dial, `/exceptions` queue, "Complete is
demonstrated, not asserted"); the three discovery briefs — `accounting-manager.md` (A3 real-time status,
A5 error-rate-per-person, B2 attribution, B5 workload/capacity, B8 autonomy & backlog metrics),
`bookkeeper-processor.md` (where the hours actually go — the workstreams to measure), and
`accounting-firm-partner.md` (A2 utilization, A6 review-queue/bottleneck, B3 review depth, B6 utilization vs
realization, B8 key-person risk). Schema verified per Rule 11 against the live migrations.

**This module EXTENDS, does not duplicate, the existing supervision surface:**
- `/operations` + `GET /api/operations` already compute org-level `totals`, `byActor` (HUMAN/AI/SYSTEM),
  `aiTiers`, `autonomyRate`, and a recent-activity feed — **but nothing is sliced per person.**
- `GET /api/client-health` already computes **per-entity** backlog (`pendingBankTxns`, `flaggedItems`,
  `oldestUncategorizedDays`, `overdueBills`, `status`) and a ranked "who's behind" flag list — **but keyed
  to location/entity, never to the human who owns it.**
- **The missing axis is the PERSON.** This module adds the per-actor slice on top of the same
  `core.action_log` spine and the same live-ledger reads, so it inherits "demonstrated, not asserted"
  (metrics are derived from ledger/log state, never manually typed).

**Canon guardrails this module must honor:**
- `gl_entries.created_by/posted_by` are uuid-nullable and **written NULL for AI** (CANON §2). Human/machine
  identity for attribution therefore MUST come from `core.action_log` (`actor_type`, `actor_user_id`) and
  `audit_log`, **never** from `gl_entries.created_by`. This is load-bearing — a metric that reads
  `created_by` for "who posted this" will silently undercount and mis-attribute.
- Generic/white-label (CANON §2): no Merit-specific roles, entities, or thresholds hardcoded. Every
  benchmark, weight, and threshold is **tenant/segment config** (mirrors the manager brief Part C rule:
  *mechanisms are core, values are config*).
- This is a **read/analytics module**. It never posts to the ledger, never moves money, never changes a
  permission. It is a lens over existing logs. That bounds its risk surface to **data exposure** (who may
  see whose numbers) — see Dimension 15.

**Explicit three-lens framing (used throughout):**
- **Manager lens (accounting_manager / company_admin / firm partner):** team leaderboard, per-person
  scorecards, per-entity coverage, "who is behind," capacity-vs-load, review-bottleneck, training signals.
  This is the owner's primary ask.
- **IT / system-admin lens:** engagement/adoption (active days, last-active, license utilization), workload
  distribution and single-points-of-failure (key-person risk), instrumentation health (is `action_log`
  actually being written on every action — the data-quality meta-metric), and RBAC of the dashboard itself.
- **Bookkeeper-being-measured lens:** a person sees **their own scorecard** (throughput, latency, quality,
  autonomy leverage, "un-buried" trend) — but **not peers' numbers or the ranked leaderboard** (privacy;
  Dimension 15). The framing is *coaching, not surveillance*: the metrics must reward accuracy and
  judgment, not raw volume, and must normalize for job mix — otherwise they punish the senior who does the
  hard accruals and reward the junior who batch-approves 500 clean utility bills.

---

## §1. Sixteen-dimension brief

### Dimension 1 — Purpose & the objective KPI catalog

**Purpose:** give a manager an objective, real-time, fair read on how each person (and the team, and the AI)
is performing across the actual bookkeeping workstreams, so they can supervise, coach, load-balance, and
sign the close with confidence — replacing the manager brief's "I assemble status by pinging people" (A3)
with a derived-from-ledger dashboard.

The catalog is organized into six families: **Throughput, Cycle-time/Latency, Quality, Autonomy/AI-leverage,
Engagement, and Manager rollups.** Every KPI below carries: *definition · exact formula · data source +
timestamps · grain · good-direction + rough benchmark · fairness / anti-gaming caveat.*

> **Notation.** `AL` = `core.action_log`. `BT` = `public.bank_transactions`. `GL` = `public.gl_entries`.
> `AID` = `public.ai_decisions`. A "person" = `core.users.id` (resolved from `AL.actor_user_id`). "Period"
> = a caller-selected window (day / week / month / fiscal period). All money is bigint cents (CANON).

#### Family A — THROUGHPUT (volume of finished work)

| # | KPI | Definition | Exact formula | Data source + timestamps | Grain | Good direction + rough benchmark | Fairness / anti-gaming caveat |
|---|---|---|---|---|---|---|---|
| T1 | **Transactions categorized/approved** | Bank/CC feed lines this person approved | `count(BT where approved_by = user AND approved_at ∈ period)` (fallback: `AL where action='bankfeed.approve' AND actor_user_id=user`) | `BT.approved_by`, `BT.approved_at` | person / entity / team / period | Higher, but see caveat. Full-charge desk ≈ 200–600 lines/day at a clean book | **Volume ≠ value.** One-click batch-approving 500 ≥90%-confidence lines is trivial; hand-coding 20 ambiguous ones is the real work. NEVER rank on raw count — weight by difficulty (see composite T7) and always pair with quality (Q-family). |
| T2 | **Journal entries created / posted** | Manual + adjusting JEs this person authored | `count(AL where action IN ('je.create','je.post') AND actor_user_id=user AND created_at ∈ period)` (NOT `GL.created_by` — NULL for AI) | `AL.created_at`; cross-check `GL.posted_at`, `GL.source_module='MANUAL'` | person / entity / period | Context-dependent; accruals/rev-rec JEs are high-judgment, low-count | A senior posting 10 complex accruals outproduces a junior posting 100 rote reclasses. Segment by `source_module` and entry complexity; do not sum raw JE counts across skill tiers. |
| T3 | **Bills processed (AP)** | Bills this person entered / approved-to-pay | entered: `count(AL where action='bill.create' AND actor=user)`; approved: `count(bills where approved_by_user=clerkId AND status advanced ∈ period)` | `bills.approved_by_user` (Clerk text), `bills.created_at`, `bills.paid_at` | person / entity / period | Higher throughput at stable error rate | Separate *entry* from *approval* (SoD, Dim 15) — never credit one person for both sides of the same bill; that would also reward a control violation. |
| T4 | **Invoices issued (AR)** | Customer invoices this person created/sent | `count(AL where action IN ('invoice.create','invoice.send') AND actor=user AND created_at ∈ period)` | `AL`; cross-check `invoices.created_at` | person / entity / period | Higher, at correct rev-rec treatment | Reward correctness of rev-rec split (Deferred Revenue vs Revenue, CANON §3), not invoice count — see Q4. |
| T5 | **Receipts matched** | Receipt→charge matches this person confirmed | `count(AL where action='receipt.match.confirm' AND actor=user)` (fallback `BT.matched_receipt_id` set within period) | `AL`; `BT.matched_receipt_id` | person / entity / period | Higher match-completion % | Matching the easy exact-amount pairs is cheap; leaving the ambiguous ones unmatched games the count. Pair with the *unmatched-aging* backlog (E4). |
| T6 | **Reconciliations completed** | Bank/CC accounts this person reconciled to statement in period | `count(distinct reconciliation finalize events in AL where action='recon.finalize' AND actor=user)` | `AL`; bank-rec finalize (see FPB-bank-reconciliation Dim 5) | person / entity / period | 100% of assigned accounts reconciled by close-day-N | **Unreconciled = not done** (manager A2). A "completed" recon with a forced plug is worse than an open one — cross-check the discrepancy/adjustment size (Q from bank-rec) so a plug-to-zero doesn't score as a win. |
| T7 | **Difficulty-weighted throughput (composite)** | Total finished work, each unit weighted by a configured difficulty factor | `Σ over finished items ( w[action_type] × item )` where `w` is tenant config (e.g. batch-approve=0.2, hand-coded categorize=1, accrual JE=3, intercompany=4) | all of the above via `AL.action` | person / team / period | Higher; this is the headline "productivity" number | The single most important anti-gaming construct: it **normalizes for job mix** so volume of trivial work can't beat a smaller volume of hard work. Weights are config, reviewed by the manager, and versioned. |

#### Family B — CYCLE TIME / LATENCY (speed, from real timestamps)

| # | KPI | Definition | Exact formula | Data source + timestamps | Grain | Good direction + rough benchmark | Fairness / anti-gaming caveat |
|---|---|---|---|---|---|---|---|
| C1 | **Upload → categorized latency** | Time a feed line waits before it's coded | `median(categorized_at − BT.created_at)` over period | `BT.created_at`; **`categorized_at` DOES NOT EXIST — see Dim 13 gap.** Interim proxy: `AL` event for `bankfeed.categorize` | entity / person / period | Lower; < 2 business days at a well-run desk | Latency is partly outside the person's control (feed timing, waiting on a client answer). Exclude time in a "blocked/waiting-on-doc" state (Dim 13 needs that state stamped) or it penalizes the diligent person chasing support. |
| C2 | **Categorized → approved latency** | Review lag between coding and approval | `median(BT.approved_at − categorized_at)` | `BT.approved_at`; needs `categorized_at` | entity / reviewer / period | Lower; same-day at close | This measures the *reviewer/approver*, not the preparer — attribute to the approver, and don't let a fast approval that skips scrutiny look good (pair with Q1 rework). |
| C3 | **Bill received → paid (AP cycle)** | Days from bill in the door to payment | `median(bills.paid_at − received_at)` | `bills.paid_at`; **`received_at` missing — `created_at` is entry time, a proxy; see Dim 13.** `due_date` for on-time% | entity / person / period | Pay on-time, not early or late; on-time-payment % > 95% | Fastest-pay is NOT best (early payment hurts cash). Score **on-time relative to `due_date` and terms**, not minimum latency. |
| C4 | **Days-to-close a period** | Business days from period end to HARD_CLOSE | `close_completed_at − period_end` in business days | `fiscal_periods.status` transitions; **no `closed_at` timestamp — see Dim 13.** Interim: last posting `AL` event before lock | entity / team / period | Lower; best-in-class 3–5 business days | Team-level metric; don't hang it on one person. A rushed close that gets reopened is worse than a day-late clean one (cross-check reopen events, Q3). |
| C5 | **Average approval latency (any workstream)** | Mean queue-wait before a human dispositions an item | `mean(disposition_at − created_at)` over AID + queue items | `AID.created_at`, `AID.disposition_at`; `AL` tiered items | person / team / period | Lower, within SLA | A person can "improve" this by approving without reading. Always co-report with the override/rework rate; speed is only good if quality holds. |

#### Family C — QUALITY (accuracy, the counterweight to volume)

| # | KPI | Definition | Exact formula | Data source + timestamps | Grain | Good direction + rough benchmark | Fairness / anti-gaming caveat |
|---|---|---|---|---|---|---|---|
| Q1 | **Rework / correction rate** | Share of a person's posted work later edited/reversed | `count(items by user later corrected) / count(items by user)`; correction = a reversing/adjusting GL entry or an edit `AL` event referencing the original | `GL.entry_type` (reversal), `AL` action `*.edit`/`*.reverse` with `subject_id` link; **a `corrected_from` link is missing — see Dim 13** | person / entity / period | **Lower**; < 2–3% healthy, > 8% is a coaching signal | This is the primary quality gauge — but a correction can be someone *else's* fix of a systemic issue, or a legitimate late accrual, not an "error." Require the correction to carry a reason/category; count only true error-corrections. Never weaponize raw reversal counts. |
| Q2 | **Exceptions generated vs resolved** | Items this person's work sent to `/exceptions`, and how many they cleared | generated: `count(AID where created_by_user=user AND status='PROPOSED'→ escalated)`; resolved: `count(AID where disposition_by_user=user)` | `AID.status`, `AID.disposition_by_user`, `AID.disposition_at`; `AL.tier='escalate'` | person / entity / period | Resolve ≥ generate (net backlog flat/declining) | Generating exceptions is often *correct* (fail-closed, manager B4/B9) — do NOT punish it. Reward *resolution throughput and net-backlog control*, not a low generation count (which would incentivize sloppy auto-approval). |
| Q3 | **Post-close / reopen error rate** | Material errors that escaped to a closed period | `count(reopen or post-lock correction events attributable to user) / closes` | `fiscal_periods` reopen `AL` events; period-lock breach audit | person / entity / period | **Lowest priority to have any**; ~0 target | Manager B10: one escaped material error costs more trust than a thousand correct auto-posts. But attribute fairly — a reopen can be a policy change from above, not a preparer error. |
| Q4 | **Auto-approve override rate** | How often a human had to overturn an AI proposal the person owns | `count(BT where final_account_id ≠ ai_account_id AND approved_by=user) / count(BT approved_by=user)`; and `AID rejected / (approved+rejected)` | `BT.ai_account_id` vs `BT.final_account_id`, `BT.approved_by`; `AID.status` | person / AI-vs-human / entity / period | Context: a *low, stable* override rate on trusted tasks = calibrated AI; a *rising* rate = investigate (manager B8/B10) | This measures the **AI's** calibration as much as the person's — read it as a joint metric. Do not reward a human for rubber-stamping AI (0 overrides could mean not looking); pair with Q1 (did rubber-stamped items get reworked later). |
| Q5 | **Review catch rate** | Errors a reviewer caught before delivery | `count(review points raised by reviewer that changed the entry) / items reviewed` | `AL` review-note events (needs review-note instrumentation, Dim 13) | reviewer / period | Higher catch = effective review; too high may mean weak preparers upstream | A high catch rate is good for the reviewer but is also a *training signal about the preparer* (manager A5). Present as a paired preparer↔reviewer view, not a solo score. |

#### Family D — AUTONOMY / AI-LEVERAGE (machine vs human)

| # | KPI | Definition | Exact formula | Data source + timestamps | Grain | Good direction + rough benchmark | Fairness / anti-gaming caveat |
|---|---|---|---|---|---|---|---|
| D1 | **Machine-vs-human work split** | Share of finished work done by AI vs humans | `count(AL where actor_type='AI') / count(AL all actors)` over period, sliced by workstream | `AL.actor_type` | org / entity / workstream / period | Rising AI share **at stable/low override** = healthy automation (manager B8) | Do NOT let humans look "less productive" as AI share rises — the goal is the human's day flips from *typing to supervising* (processor brief Part 3). Re-baseline human throughput expectations as autonomy rises; never use D1 to justify "the human did less." |
| D2 | **Autonomy rate & trend** | Share of AI actions that ran at the `auto` tier without human touch | `AL.tier='auto' / (auto+review+escalate)` among `actor_type='AI'` (already computed org-wide by `/api/operations`) | `AL.tier`, `AL.confidence` | org / entity / task / period | Rising, **only if** override (Q4) and escaped-error (Q3) stay low | Autonomy that rises while errors rise is the kill-switch trigger (manager B10). This metric governs the dials — it must be read *with* quality, never alone. |
| D3 | **Exceptions cleared per human-hour** | Human efficiency at the new (supervisory) job | `count(exceptions resolved by user) / active_hours(user)` | `AID.disposition_*`; active-hours proxy from `AL` activity spans (true hours needs session data, Dim 13) | person / team / period | Higher = the human is well-leveraged by the AI | "Hours" is a proxy (no true time-in-system). Don't turn this into a stopwatch; it's a leverage indicator, not a timesheet. Clearing an exception fast but wrong is caught by Q1. |
| D4 | **Human-touch ratio per entity** | How much manual intervention an entity still needs | `count(AL actor_type='HUMAN', entity) / count(AL all, entity)` | `AL.actor_type`, `AL.location_id` | entity / period | Falling as the AI earns trust on that book | A high human-touch entity may be *inherently* complex (construction WIP, intercompany), not badly run — normalize by entity tier/complexity config before comparing entities. |

#### Family E — ENGAGEMENT (adoption, presence, workload)

| # | KPI | Definition | Exact formula | Data source + timestamps | Grain | Good direction + rough benchmark | Fairness / anti-gaming caveat |
|---|---|---|---|---|---|---|---|
| E1 | **Active days** | Distinct days the person took any logged action | `count(distinct date(AL.created_at) where actor_user_id=user)` in period | `AL.created_at`, `AL.actor_user_id` | person / period | Consistent with schedule; not a target to maximize | Presence ≠ productivity. This is an IT/adoption signal (is the license used, is someone AWOL), NOT a performance rank. Never rank people by hours-online — that is the classic surveillance anti-pattern. |
| E2 | **Last active** | Most recent logged action | `max(AL.created_at where actor_user_id=user)` | `AL.created_at` | person | Recent; staleness flags an off-boarding/coverage gap | Use for coverage/off-boarding hygiene (IT lens), not to shame. A reviewer who acts in bursts at close is not "inactive." |
| E3 | **Workload distribution / concentration** | How evenly work (and ownership) is spread across the team | Gini/share of difficulty-weighted throughput (T7) by person; and entity-coverage concentration (how many entities depend on one person) | `AL` + assignment model (**assignment/ownership table missing — Dim 13**) | team / entity | Balanced; no single point of failure (partner B8 key-person risk) | Concentration flags a *management/staffing* problem, not an individual's fault. The overloaded person is not "over-performing" — surface burnout risk, don't celebrate it. |
| E4 | **Backlog aging per person** | Oldest/mean age of open items the person owns | `mean/max(now − created_at)` over open `BT`/`bills`/exceptions assigned to user | `BT.created_at` (PENDING), `bills` open, `AID` PROPOSED; needs assignment link | person / entity / period | Lower/stable; rising backlog = early warning (manager A3/B5) | Backlog can grow because the person was handed too much, or is out. Read with capacity (M5); don't score a person "behind" who is structurally under-resourced. |

#### Family F — MANAGER ROLLUPS (the supervisory views)

| # | View | Definition | Composition | Grain | Notes |
|---|---|---|---|---|---|
| M1 | **Team leaderboard / ranking** | Ranked team view on the difficulty-weighted composite (T7) + quality guardrails | rank by T7, **gated** so anyone above a rework/error threshold (Q1/Q3) is flagged not celebrated | team | Manager-only. Ranking is on *value-weighted, quality-gated* output — never raw volume (Dim 15 privacy). |
| M2 | **Per-person scorecard** | One person's full card across all six families, trended | all KPIs above for one `core.users.id`, with sparklines vs their own prior periods | person | The bookkeeper sees THEIR OWN card (self-view); the manager sees anyone's. |
| M3 | **Per-entity coverage** | For each entity: who owns it, its health, and its human-touch ratio | join `client-health` (existing) × owner (assignment model) × D4 | entity | Extends existing `/api/client-health` with the person axis. |
| M4 | **"Who is behind" flags** | Ranked people/entities at risk vs close calendar | reuse `client-health` flag ranking, re-keyed to owner; add per-person backlog aging (E4) | person / entity | Extends the existing ranked-flag list with an owner column. |
| M5 | **Capacity vs load** | Assigned/committed work vs the person's demonstrated throughput | `open weighted workload (E4×T7 weights) / trailing throughput (T7)` → projected time-to-clear vs deadline | person / team | Partner A2/B6; needs the assignment model. Warn when queue grows faster than it clears (manager B5). |
| M6 | **Preparer → reviewer pairing** | The SoD chain quality view | Q5 catch rate × preparer rework (Q1), paired | preparer↔reviewer | Training + bottleneck signal (partner B3), not a solo score. |

### Dimension 2 — User personas & primary jobs-to-be-done

- **Accounting manager / controller:** "Where is every entity and every person right now; who's behind;
  who needs coaching; can I sign the close." Primary consumer of M1–M6.
- **Firm partner (practice tenant):** the above **across many client tenants** — portfolio leaderboard,
  utilization/realization, key-person risk, review bottleneck (partner brief Part B). Same mechanisms,
  cross-tenant aggregation (respecting per-tenant RLS; a partner acts across tenants via the multi-client
  identity model — CANON, not yet built; this module reads within-tenant and rolls up at the practice
  plane later).
- **IT / system admin:** adoption/licence utilization (E1/E2), workload concentration & key-person risk
  (E3), and **instrumentation health** — the meta-metric that `action_log` is actually being written on
  every action (Dim 16); a metric layer on incomplete logging silently lies.
- **The bookkeeper being measured:** their own scorecard (M2, self-scoped) — an "am I improving / am I
  un-buried" view (processor brief Part 3 "un-buried"), NOT peer comparison.

### Dimension 3 — UI / screens (states: loading / empty / populated / error)

- **`/operations/team` (new sub-view under the existing Operations area)** — Manager landing:
  1. **KPI strip:** team difficulty-weighted throughput (T7), median cycle-times (C1–C4), team rework rate
     (Q1), org autonomy rate (D2, reuse existing), active people (E1).
  2. **Leaderboard table (M1):** person · weighted throughput · rework % · avg latency · autonomy leverage ·
     backlog age · trend spark. Sortable columns (Rule 5). Quality-gated highlighting (red if rework over
     threshold). **Manager-only.**
  3. **"Who's behind" panel (M4):** ranked flags with owner column (extends existing client-health flags).
  4. **Coverage matrix (M3):** entity × owner grid with health + human-touch ratio.
- **`/operations/team/[userId]` — Per-person scorecard (M2):** six-family card, trended sparklines, drill
  into the underlying `action_log` rows (the audit trail behind every number — manager B7).
- **`/me/scorecard` — self-view:** the same M2 card scoped to the caller, **no leaderboard, no peers.**
- **Empty state:** "No activity logged in this window" (also a data-quality prompt for IT: is logging
  wired?). **Error state:** query error surfaced, never a blank. **Loading:** skeleton rows.
- Design system: emerald primary, dark surfaces, JetBrains Mono for the numbers (CLAUDE.md design system).

### Dimension 4 — Filters, grain & period selection

Period selector (day / week / month / **fiscal period** / custom) — Rule 7 mandatory. Grain toggle
(person / entity / team / workstream). Workstream filter (bank feed / AP / AR / receipts / recon /
payroll / JE). Actor-type filter (human / AI / system — reuse the `/operations` control). All slices ride
the same `AL.created_at` window + `actor_user_id` / `location_id` / `action` predicates.

### Dimension 5 — Computation approach

- **Read model, not write model.** Aggregate over `core.action_log` (the spine) plus targeted live-ledger
  reads (`BT`, `bills`, `AID`, `fiscal_periods`) exactly as `/api/operations` and `/api/client-health`
  already do — grouped queries aggregated in JS, never per-person N+1.
- **Phase 1 (today):** on-the-fly aggregation over the last-N-days window (cap rows, like the existing
  routes). Fine at current data volumes (17 entities, one org).
- **Phase 2 (scale):** a nightly materialized rollup table (`core.performance_daily` — person × entity ×
  workstream × day → counts, latency percentiles, rework, autonomy) so month/quarter views are cheap and
  trends are precomputed. Spec'd in Dim 13.
- **Difficulty weights (T7) and thresholds** live in a tenant `core.performance_config` (Dim 13) — versioned
  so a weight change is auditable and doesn't silently rewrite history.

### Dimension 6 — Benchmarks & good-direction (per KPI)

Each KPI ships with a **direction** (higher/lower/on-target) and a **tenant-configurable band** (green /
amber / red), seeded with the rough benchmarks in the §1 tables. Bands are **segment config** (a
construction holdco, a SaaS startup, and a nonprofit draw the lines differently — manager brief Part C).
Nothing is hardcoded to Merit.

### Dimension 7 — AI behavior (the AI dimension)

All AI here is **read/advisory only** — it never posts, never changes a score, routes through
`@meritbooks/core-ai`, meters to `core.ai_usage_log`, and every summary it writes lands in `AL`/`AID`:
- **AI-written performance summaries:** a plain-English narrative per person/team/period ("Jordan's
  weighted throughput rose 12% while rework held at 2%; latency on AP approvals slipped — 3 bills aged past
  terms"). Grounded strictly in the computed KPIs (no invented numbers).
- **Coaching flags:** detect *patterns*, not one-offs — "same cut-off error 3 months running" (manager A5
  training signal), "override rate on vendor X rising → AI miscalibration or coding drift," "backlog growing
  faster than cleared (manager B5)."
- **Fairness sentinel (anti-gaming, AI-assisted):** flag suspicious signatures — throughput up while
  quality down, a spike in trivial batch-approvals inflating T1, or latency improving because review is
  being skipped. The AI's job here is to *protect* the fairness of the metric, surfacing gaming to the
  manager rather than letting a number be exploited.
- **Human posture:** every AI output is a *proposal to the manager*, explainable and dismissible. It never
  determines pay, ranking, or discipline autonomously.

### Dimension 8 — Acceptance criteria (testable, Rule 3)

A build is Complete for this module only when ALL hold:
1. Every §1 KPI computes from the cited real source over a selectable period, for person/entity/team grain,
   with loading/empty/populated/error states.
2. Attribution reads `action_log`/`audit_log` (`actor_type`,`actor_user_id`) — **verified never to read
   `gl_entries.created_by`** for "who did this" (guard test).
3. The difficulty-weighted composite (T7) is live and every raw-volume metric is displayed **paired with a
   quality metric** — no volume KPI appears alone (anti-gaming acceptance gate).
4. RBAC: a bookkeeper's self-view returns only their own rows; a request for a peer's scorecard or the
   leaderboard by a non-manager is denied (tenant-isolation + role test).
5. Cross-tenant isolation holds (a manager sees only their org's people) — RLS test, mirrors
   `tenant-isolation.test.ts`.
6. Every number is drill-through to its underlying `action_log` rows (demonstrated, not asserted).
7. AI summaries cite only computed KPIs (no hallucinated figures) — snapshot test on the prompt contract.

### Dimension 9 — Data model changes required (the gap list, Rule 11)

**Computable TODAY from existing columns (no schema change):**
- T1 (BT.approved_by/approved_at), T2/T3/T4/T5 (AL.action + actor_user_id), Q4 (BT.ai_account_id ≠
  final_account_id), D1/D2/D4 (AL.actor_type/tier/location_id), E1/E2 (AL.created_at/actor_user_id),
  E4 partial (BT/bills open-item aging), M3/M4 (extend existing client-health with an owner column *once an
  owner exists*), Q2 (AID.status/disposition), C3 partial (bills.created_at→paid_at), C5 (AID
  created_at→disposition_at). **The org-level autonomy rate and actor split already ship in `/api/operations`.**

**Needs a schema change / new column / new event before it's honest:**
| Gap | Why | Proposed change |
|---|---|---|
| **`bank_transactions.categorized_at`** | C1/C2 need the middle timestamp; only `created_at` (upload) and `approved_at` exist — the CATEGORIZED transition is untimed | add `categorized_at timestamptz`, set on the PENDING→CATEGORIZED transition |
| **`bills.received_at`** | C3 true AP cycle starts at receipt, not entry; `created_at` is entry time | add `received_at timestamptz` (email-ingest/upload time) |
| **`fiscal_periods.close_started_at` / `closed_at`** | C4 days-to-close needs the close timestamps; only status enum + `created_at` exist | add both timestamps, set on SOFT_CLOSE / HARD_CLOSE transitions |
| **Correction linkage (`corrected_from`)** | Q1/Q3 rework rate needs to tie a reversal/edit to the original item and a reason | add `corrected_from_id` + `correction_reason` on adjusting entries (or a `core.corrections` link table) |
| **A "blocked / waiting-on-doc" state stamp** | C1/C3 fairness — exclude time waiting on a client so latency doesn't punish the diligent (processor "chasing people") | a status/interval on the item or an `AL` blocked/unblocked event pair |
| **Assignment / ownership model (`core.assignments`)** | E3/M3/M5 "book of responsibility" (person owns these entities/desks) — the partner brief's assignment grid; today ownership is implicit | new table: user × entity × workstream × role (preparer/reviewer/partner), audited re-assignment |
| **`core.performance_config`** | T7 weights + green/amber/red bands per tenant/segment (fairness = config, not code) | new tenant config table, versioned |
| **`core.performance_daily` (rollup)** | Phase-2 scale for month/quarter trends | nightly materialized person×entity×workstream×day rollup |
| **Review-note instrumentation** | Q5 review catch rate; review points aren't a first-class logged event yet | log `review.note.raise` / `review.note.clear` to `AL` (or a review_notes table) |
| **True time-in-system (session spans)** | D3/E1 "hours" are currently action-span proxies | optional session/heartbeat log — treat as low priority; the proxy is fine and avoids surveillance creep |
| **Comprehensive `action_log` write coverage** | *The* dependency: metrics are only as good as instrumentation. Many routes don't yet call `logAction`/`logHumanAction` with a resolved `actor_user_id` | audit every mutating route; ensure each writes `AL` with a real actor. This is the meta-acceptance gate (Dim 16). |

### Dimension 10 — QBO / Karbon / Jetpack Workflow / practice-management benchmark (Rule 14, NAMED DELTAS)

| Competitor | What they do | MeritBooks delta (why we win) |
|---|---|---|
| **QuickBooks Online (+ QBO Accountant / Work)** | Has a "My Accountant" and QBOA **Work** with client/project close checklists and simple team assignment; an **Audit Log** of who-did-what. But **no productivity analytics, no throughput/latency/quality KPIs, no leaderboard** — Work tracks task status, not performance, and the audit log is forensic, not analytic. | We compute *objective performance from the ledger itself* (throughput/latency/quality/autonomy), not manual task ticks. QBO can't measure cycle-time or rework because it isn't the timestamped book of record end-to-end; **we own the GL and the `action_log` spine**, so our metrics are derived, not entered. |
| **Karbon** | Best-in-class practice-management: work status, **budget-vs-actual time**, capacity/utilization, client assignment grid, review workflow. Strong on *time/utilization*. | Karbon measures **time entered on tasks** (timesheet-driven, gameable, manual). We measure **finished accounting output and its quality directly from the ledger** — no timesheets. We add **AI-vs-human attribution and autonomy leverage** (D-family), which a timesheet tool structurally cannot have. Delta: *outcome-based & AI-aware vs input/time-based.* |
| **Jetpack Workflow / Financial Cents / Client Hub** | Recurring close checklists, deadline tracking, "who's behind," basic staff workload. | These are *checklist trackers bolted beside* the accounting system; status is manually updated (violates our "demonstrated, not asserted"). Ours is **derived from live ledger/log state** and adds real cycle-time, rework, and autonomy metrics they don't have. |
| **Keeper / Uncat** | Uncategorized-transaction cleanup + client Q&A, some team assignment. | We fold uncategorized-aging into a *fuller* per-person quality/backlog picture (E4/Q-family) and tie it to the autonomy dial, not a standalone cleanup tool. |

**Named headline deltas:** (1) *ledger-derived, not timesheet/checklist-entered* metrics; (2) a
**difficulty-weighted, quality-gated** composite that resists volume-gaming — none of the above normalize
for job mix; (3) **AI-vs-human attribution + autonomy-leverage** metrics that only an AI-native owned-ledger
can produce; (4) a **fairness sentinel** that actively polices gaming.

### Dimension 11 — Fairness & anti-gaming (the emphasized cross-cutting principle)

The dominant design risk is a metric that **rewards volume over accuracy or fails to normalize for job
mix** — punishing the senior on hard accruals, rewarding the junior batch-approving clean lines, and
incentivizing corner-cutting (fast approvals that skip scrutiny; leaving hard items unmatched to protect a
count; auto-approving to suppress exception generation). Mandatory countermeasures, baked into acceptance
(Dim 8.3):
1. **Never rank on raw volume.** The headline is the **difficulty-weighted composite (T7)**, weights = config.
2. **Every volume KPI is displayed paired with a quality KPI.** No T-metric ships alone.
3. **Quality gates the leaderboard:** anyone over a rework/error threshold is *flagged, not celebrated*.
4. **Latency excludes blocked/waiting-on-client time** (needs the blocked-state stamp, Dim 13) so diligence
   isn't punished.
5. **Generating exceptions is not penalized** (fail-closed is correct) — only net-backlog and resolution
   throughput are scored.
6. **Normalize per entity complexity/tier** before comparing entities or people across different books.
7. **The AI fairness sentinel** (Dim 7) actively surfaces gaming signatures to the manager.
8. **Human judgment is final** — metrics inform coaching/staffing; they never auto-determine pay, ranking,
   or discipline (manager B10: the supervisor's judgment is the final gate).

### Dimension 12 — Module-level acceptance gates (roll-up)

Renders in all states; every KPI from real sources; per-person/entity/team grain + period selector;
attribution from `action_log` not `gl_entries.created_by`; T7 live and volume-paired-with-quality; RBAC
self-view vs manager-view enforced; cross-tenant isolation proven; drill-through to `action_log`; AI
summaries grounded. TypeScript, no `any`, loading/error/empty everywhere (Rules 3/5/10).

### Dimension 13 — Data model changes required to reach Complete

*(Full detail in Dimension 9's gap table.)* Ordered: (a) **instrument `action_log` comprehensively** — the
prerequisite for every metric; (b) add the missing timestamps (`categorized_at`, `received_at`,
period `closed_at`); (c) add `core.assignments` (unlocks E3/M3/M5); (d) add `core.performance_config`
(weights/bands); (e) correction linkage + blocked-state stamp (fairness); (f) review-note events (Q5);
(g) `core.performance_daily` rollup (scale). All additive, migration-numbered, RLS-on, org-scoped — applied
to Supabase FIRST per the workflow.

### Dimension 14 — RBAC & privacy (three-lens, the sensitive part)

- **Manager tier** (`company_admin`, `accounting_manager`, and a firm `partner` role): full team
  leaderboard, any person's scorecard, coverage, capacity — scoped to their org (and, at the practice
  plane, their client set).
- **IT / system-admin:** engagement/adoption + instrumentation-health views; may or may not see individual
  performance depending on tenant policy (config) — separate the "is the system used / is logging healthy"
  lens from the "how good is this person" lens.
- **Bookkeeper (measured):** **self-scorecard only.** `GET /me/scorecard` returns rows where
  `actor_user_id = caller`. A non-manager requesting `/operations/team` or another `userId` is **denied**
  (require-permission on a new `team_performance:view_all` permission vs `view_self`). This is a **privacy
  boundary**, not just an access gate — peers' numbers are not visible laterally.
- **Cross-tenant:** RLS on every source table already isolates by `org_id = get_org_id()`; the read routes
  must use the RLS client (like `/api/client-health`), never leak across orgs. Name resolution via the
  service role must be **id-scoped to org rows only** (the exact pattern `/api/operations` already uses).
- **Audit:** viewing performance data is itself logged (a manager pulling scorecards is an `AL` event) —
  the surveillance surface is itself supervised.

### Dimension 15 — Segmentation (common-core vs tenant/segment config)

Per the manager brief's rule (*mechanisms core, values config*): the **metric mechanisms, the six families,
the attribution model, the fairness gates, the RBAC boundary** are common core (every tenant). The
**difficulty weights (T7), green/amber/red bands, benchmark targets, close-calendar/business-day-N,
entity-complexity tiers, and which workstreams exist** are tenant/segment config in
`core.performance_config` — never forked code paths.

### Dimension 16 — Current-state ledger row (Rule 15) + instrumentation-health meta-metric

- **Current state:** `/operations` shows org-level actor split + autonomy + recent feed; `/api/client-health`
  shows per-entity backlog + "who's behind" flags. **No per-person performance layer exists** — this module
  is *Not started* (spec only). Feature Completeness Ledger: add row "Team Performance — Not started (FPB
  written)."
- **Instrumentation-health meta-metric (IT lens, gates trust in every other number):** `% of mutating
  actions that produced an `action_log` row with a resolved `actor_user_id``. If this is low, the whole
  dashboard is lying — so it is surfaced first, to IT, as the data-quality gate. A performance layer built
  on incomplete logging violates "demonstrated, not asserted."

---

## §2. Build sequence — what's computable TODAY vs needs-a-schema-change

**Wave 0 (prerequisite, infra):** audit every mutating route; ensure comprehensive `action_log` writes with
resolved `actor_user_id` (Dim 16). Add the instrumentation-health meta-metric. *No performance number is
trustworthy until this passes — do this before UI (Rule 10: don't build UI when the priority is infra).*

**Wave 1 (TODAY, zero schema change):** ship the read model + `/operations/team` with the metrics that
compute from existing columns — T1, T2–T5, Q4, Q2, D1/D2/D4, E1/E2, E4-partial, C3-partial, C5; the
leaderboard (M1) on a **provisional** T7 (weights in code-config until the config table lands); "who's
behind" (M4) and coverage (M3) extended from `client-health`; the self-scorecard (M2 self-view) + RBAC
boundary. This alone closes the owner's "no performance indicators" gap.

**Wave 2 (schema changes, then metrics):** apply migrations for `categorized_at`, `bills.received_at`,
period `closed_at`, `core.performance_config`, `core.assignments` → light up C1/C2/C4 (true latencies),
M5 capacity-vs-load, E3 concentration, tenant weights/bands.

**Wave 3 (quality depth + scale):** correction linkage + blocked-state stamp (honest Q1/Q3 and fair
latency), review-note events (Q5), `core.performance_daily` rollup (month/quarter trends), the AI summaries
+ coaching flags + fairness sentinel (Dim 7).

## §3. Definition of Complete

Complete when the Dimension 8 acceptance criteria pass, verified (tests green, security GO on the RBAC/
privacy boundary and cross-tenant isolation, chrome-audited render), and the Feature Completeness Ledger row
is updated by the scribe from git + live schema — not asserted.
