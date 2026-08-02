# MeritBooks — Session 43 Handoff

**Date:** 2026-08-02
**Supersedes:** session 42. Use this as the current source of truth for build state.
**Companion:** `docs/canon/CANON-ANCHOR.md` (re-ground anchor), `docs/NORTH-STAR.md`
(product spine), the AI-capability master (`docs/discovery/AI-CAPABILITY-MATRIX.md` +
`INTEGRATION-MAP.md`), and the FPBs (invoices, financial-reports, bank-reconciliation,
payroll, financial-control-exceptions, team-performance, identity-multitenancy,
tenant-model-consolidation-analytics, payments-fees, **nl-copilot** [new]).

> **Coordination note (read first):** two Cowork sessions commit to this one repo —
> **MeritBooks** (this handoff) and **MeritProjects** (Module 6, the `feat(projects): …`
> commits). Disjoint workstreams sharing one git history, one Supabase, one migration
> sequence. Rules in force: **path-scoped `git add`** (never `git add -A`), and **disjoint
> migration bands — Books `0xx`, Projects `1xxx`.** In this handoff, ignore the `projects`
> commits (`3b9324e`, `000384e`, migrations `1006`) except where they touch the shared spine.

---

## 1. Headline

The session that **turned "AI-native book of record" from a slogan into a proven, gap-mapped
surface, then filled the biggest blind spots.** It opened with an exhaustive AI-capability
identification (owner directive: the AI engineer coordinates with every SME so that ALL AI
functionality is identified) — a **14-modality × 24-segment master matrix** that forced every
modality against every segment and made each blank cell a provable gap. That exposed
whole-column blind spots — **NL/conversational (M8), narrative (M7), search/knowledge (M13),
learning (M14)** — plus five thin segments the coverage matrix had already named. The session
then built into those gaps, depth-first behind FPBs: a **Universal NL Command bar + FP&A
Copilot** (safe NL→ledger analytics, NL processing lanes), **AI flux/variance narrative** on
every core statement (M7), a **search/knowledge lane** (M13), an **Autonomy & Kill-Switch
Control Plane** (M10, now wired into the exception library), a **payment-run fraud screen**,
and real depth in the five thinnest segments — **consolidation (GATE 11a), job costing, fixed
assets, customer management**. A governance sweep closed the last **direct-Anthropic seams**.

Everything below is on `main`. **Production HEAD is `1061204`** (`chore(nav): add Consolidation
sidebar entry`); every Books wave commit through it built on the auto-push → Vercel `next build`
loop (the authoritative full-project typecheck). Migrations **075 (autonomy control plane)** and
**076 (consolidation ownership)** were applied to Supabase first, then the dependent code committed.

---

## 2. What shipped this session (Books)

### Exhaustive AI-capability identification (owner directive — ALL AI functionality identified)
- **The 14-modality × 24-segment master matrix** (`01837ee`, `docs/discovery/AI-CAPABILITY-MATRIX.md`)
  merges the AI-engineer's three modality-sweep panels (`ai-modality/record-to-report.md`,
  `p2p-o2c.md`, `fpna-tax-payroll-practice.md`), the external-systems layer, and the deduped
  catalog into **one screen**. Forcing **every modality against every segment** surfaced
  capabilities a segment-first catalog structurally misses.
- **~303 true distinct capabilities** identified across the grid; **~40 built pre-wave.**
- **Whole-column blind spots exposed:** **M13** search/knowledge, **M8** conversational NL,
  **M7** narrative/explanation, **M14** learning/personalization — entire modalities with near-zero
  coverage. This session built into M13, M8, M7, and M10; **M14 (learning) remains the largest
  open column.**
- **Integration map** (`docs/discovery/INTEGRATION-MAP.md`): the external-systems layer as its own
  provable surface — **~30 systems** with direction, contract, cadence, failure posture, AI role at
  the seam, and build-state (book-of-record framing: QBO/Sage are one-time import only, never sync-back).
- **Governance finding:** the matrix flagged **7 routes calling Anthropic directly** (bypassing the
  Core AI gateway / tenant budget meter) — **all fixed** this session (see gateway sweep below).

### Universal NL Command & FP&A Copilot (M8 — the pervasive NL surface)
- **FPB authored first:** `docs/FPB-nl-copilot.md` (fills the gap the session-42 handoff flagged —
  "no dedicated nl-copilot FPB yet").
- **Global command bar** (`d50ea24`, ⌘K): intent router across three lanes —
  **processing / analytical / navigation**.
- **Safe NL→ledger analytical lane** (`9c7dfff`): answers plain-English financial questions over an
  **allowlisted metric catalog** — **the model never writes SQL**; on anything outside the catalog it
  **abstains** (fail-closed) rather than guess.
- **NL processing lanes P2–P4** (`9563149`): **P2 categorize / P3 draft-bill / P4 draft-invoice** —
  each **proposes → human approves** (never auto-moves money; canon SoD intact).

### M7 — narrative / explanation on every core statement
- **AI flux/variance auto-narrative** (`8e6b389`, extended `5d5321a`): deterministic driver
  computation picks the movers; **the model only turns numbers into phrases** (never invents figures).
  Now live on **P&L, balance sheet, cash flow, and budget-vs-actual.**

### M13 — search / knowledge lane
- **`/search`** (`0a5b24a`): plain-English **find-anything over the ledger** (invoices, bills, JEs,
  vendors, accounts) — the retrieval/knowledge modality that was a whole-column blank.

### M10 — Autonomy & Kill-Switch Control Plane
- **Migration 075** (`6487c7e`, `/settings/autonomy`): **per-feature autonomy dial + a global kill
  switch**, plus a **disposition helper** that maps a proposal's score/tier to an action under the
  tenant's current dial.
- **Wired into 10 exception detectors** (`c95a510`): every control-exception proposal now records a
  **per-feature disposition** (auto / queue / hold) honoring the autonomy dial, and surfaces it on
  `/exceptions` — advancing the session-42 residual "`scoreToTier` not wired into disposition"
  from logging-only toward governed action (still human-override, still detect-only for money).

### Payment-run fraud screen
- **Detect-only fraud screen** (`3226545`) on the payment run: **new-payee, BEC/bank-account-change,
  unusual-amount, duplicate-payment** checks. Flags for **human override**; blocks a duplicate pay.
  Never releases money autonomously.

### Thin-segment depth (the five COVERAGE-MATRIX named)
- **Consolidation — GATE 11a** (`059b817`, **migration 076**, `/consolidation`): multi-entity
  consolidated financials with **ownership %, non-controlling interest (NCI), and intercompany
  eliminations**. (Nav entry added `1061204`.)
- **Job costing** (`aba24ea`): **EAC cost-to-complete forecast** + **WIP over/under-billing schedule**.
- **Customer management** (`69bb05e`): **duplicate detection + merge** + a **credit/risk dossier** per
  customer.
- **Fixed assets** (`f685493`): **depreciation methods** (declining-balance / SYD / units-of-production),
  **disposal gain/loss**, and an asset **roll-forward**.

### Gateway governance fix
- **Bill parser routed through the Core AI gateway + centralized Anthropic key read** (`8c48bbd`) —
  closes the direct-Anthropic seams the matrix flagged, so every AI call meters to
  `core.ai_usage_log` and respects the combined-suite tenant budget (canon §2 invariant).

---

## 3. Data / infra changes (reproducibility notes)

- **Books migrations applied to Supabase this session (Supabase first, then code):**
  - `075_autonomy_control_plane.sql` — per-feature autonomy dial + global kill switch (RLS).
  - `076_consolidation_ownership.sql` — entity ownership %, NCI, elimination mappings (RLS).
- Session-42 Books migrations `064–065`, `068–074` (no `072`) remain applied. **The sequence still
  skips `072`.** Projects `066/067` + `1001–1006` are applied by the MeritProjects workstream — Books
  does not own them.
- **New tests** across the deterministic engines landed this session (NL analytical allowlist/abstain,
  flux-narrative driver math, consolidation ownership/NCI/elimination tie-out, job-cost EAC/WIP,
  fixed-asset depreciation/disposal roll-forward, fraud-screen checks, autonomy disposition). The
  standing pre-existing harness failures are unchanged and are **NOT regressions:** the PGlite
  migration-replay harness fails when pglite isn't installed in the sandbox, and
  `src/test/tenant-isolation.test.ts` has a parse error — both predate session 42.
- **Nav added this session:** **Search**, **AI Autonomy**, **Consolidation** sidebar entries
  (`ba60db1`, `1061204`).
- **Key ids unchanged:** org `1d1aa1ef-4218-4187-a622-4a80da1a9e11`; Supabase project
  `npqeijipggtuduhkejxq`; Clerk user `user_3BwDOygB7TuYWcrUUt87GOVvQV1`; Vercel team
  `team_2EwoHwR0BcH6GNjMjCbMaVAW`, project `meritbooks-web`.
- **Auto-push loop still live** on Mike's machine (ships `main` commits automatically). Claude cannot
  push from the sandbox and must not handle a token.

---

## 4. Open items — DO NOT FORGET

### This session's follow-ups (task #47)
- [ ] **Fixed-asset method enum + disposal roles** — depreciation methods and disposal gain/loss
      accounts should be formalized as an enum/account-role set (currently in code).
- [ ] **Customer-merge job repoint** — merge redirects the dossier; confirm all child records
      (invoices, statements, dedup keys) repoint to the surviving customer.
- [ ] **`/jobs/wip` nav** — the WIP over/under-billing schedule needs a first-class nav entry.
- [ ] **Dedicated `payments` permission** (task #33, carried) — money routes still borrow
      checks/bills/payroll/journal_entries:create.

### Still-open gates
- [ ] **Identity gate #9 — residual** (org resolution is fixed; these remain): dedicated `payments` +
      `team_performance`/control-route permissions, **`core.assignments`** (per-user scoping),
      **event-worker read/"peek" scoping**, **location-scoped RLS**.
- [ ] **Payroll GATE 12.3 Phase B** (task #34, blocked on provider pick): releaser ≠ preparer at
      release, payroll double-post guard, live Check sandbox.
- [ ] **GATE 4 — AP OCR / email ingestion** (blocked on Azure creds from IT).
- [ ] **Remaining thin areas now in flight:** tax **book-to-tax**, **onboarding conversion**
      (QBO/Sage import), **covenant monitor**.
- [ ] **M14 (learning/personalization)** — the largest whole-column blind spot the matrix exposed;
      no code, no FPB yet.

### Known drift / deferred (carried forward from session 42)
- [ ] Invoice write-off needs a **`BAD_DEBT_EXPENSE` account role** + `v_ar_aging` to exclude `WRITTEN_OFF`.
- [ ] `api/vendors/route.ts` references `core.vendors` columns not on the live table — that path errors.
- [ ] **AP attachment**: `bills.source_file_url` null — needs a Supabase storage bucket + upload wiring.
- [ ] AP line coding falls back to acct 6660 (Misc OPEX) when no account resolves.

### Mike's manual to-dos (Claude can't do these)
- [ ] **Ratify the Master-Doc amendments** — `docs/PROPOSED-MASTER-DOC-AMENDMENTS.md` (task #19).
- [ ] **Pick the payroll provider** — Check vs. Gusto — to unblock Payroll Phase B (task #32, leaning Check).
- [ ] **Rotate the Resend API key** and set **`INVOICE_FROM_EMAIL`** for live invoice/statement email.
- [ ] **Clerk production instance** + JWT template + register Supabase (dev works now).
- [ ] **Set `EVENT_WORKER_SECRET`** (the event-worker auth guard's constant-time header secret).

---

## 5. Direction — what's next

Per the canon gate order and `NORTH-STAR.md` (autonomous engine + supervision/trust layer;
depth-first, one pipeline per parallel wave, behind an FPB):

1. **Close the identity gate #9 residual** — dedicated `payments`/control permissions,
   `core.assignments`, event-worker read-scoping, location-scoped RLS.
2. **Finish the thin-segment deepening** now in flight — tax book-to-tax, onboarding conversion,
   covenant monitor — each behind its FPB; polish consolidation / job-costing / fixed-assets /
   customer-mgmt against their follow-ups (task #47).
3. **Payroll Phase B** once the provider is picked.
4. **Extend the control library toward EC-1..EC-13** and let the autonomy plane govern more
   dispositions (it now governs 10 detectors).
5. **Open the M14 learning column** — the last untouched modality (author the FPB first).

Execution model unchanged: file-disjoint vertical slices, 3–5 concurrent builder/general-purpose
agents (all **opus 4.8**) in one message, shared spine single-threaded through the lead, migrations
to Supabase first, Vercel `next build` as the authoritative typecheck. **Two concurrent workstreams
(MeritBooks + MeritProjects) share the repo — path-scoped commits + disjoint migration bands
(Books `0xx` / Projects `1xxx`) are mandatory.**

---

## 6. Agents

Eight in `.claude/agents/` (builder, verifier, auditor, reviewer, designer, scribe, security,
chrome-auditor) plus SDK agents (general-purpose, Explore, Plan). **Every agent runs on `opus` —
`claude-opus-4-8` — no exceptions** (Owner directive, binding in CLAUDE.md §0.1). This session ran
concurrent `general-purpose`/builder waves on disjoint slices (NL / narrative / search / autonomy /
fraud / consolidation / job-cost / fixed-assets / customer-mgmt), with the gateway governance sweep
and the payment-fraud screen reviewed for the money/AI-governance seams.

---

## 7. Live state

- **Production HEAD: `main` @ `1061204`** (`chore(nav): add Consolidation sidebar entry`). Every Books
  wave commit this session shipped via the auto-push → Vercel `next build` loop (the authoritative
  full-project typecheck).
- Books migrations `064–065`, `068–076` (no `072`) applied to Supabase, including this session's
  **075 (autonomy)** and **076 (consolidation)**; Projects `066/067` + `1001–1006` applied by the
  Projects workstream.
- Clerk↔Supabase active on the **dev** Clerk instance; auto-push loop running on Mike's machine.
- **Verification:** the deterministic-engine suites for this session's builds pass on top of the
  session-42 baseline (~600 passing). **Standing pre-existing harness failures — NOT regressions:**
  pglite not installed in the sandbox; `src/test/tenant-isolation.test.ts` parse error. Both predate
  this session.

---

## 8. One-line for the next session

Start by reading `docs/canon/CANON-ANCHOR.md` then this file. Session 43 **proved the AI surface**
(14-modality × 24-segment matrix, ~303 caps, whole-column gaps named) and **built into the biggest
blanks** — Universal NL Command + FP&A Copilot (M8), statement flux narrative (M7), `/search` (M13),
the Autonomy/Kill-Switch plane (M10, now governing 10 detectors), a payment-fraud screen, and real
depth in **consolidation (11a) / job-costing / fixed-assets / customer-mgmt** (migrations 075 + 076).
**Next:** close the gate-#9 residual, finish the thin segments in flight (book-to-tax, onboarding
conversion, covenant monitor), open the **M14 learning** column — spec-first, disjoint parallel
slices, migrations-first, path-scoped commits alongside MeritProjects.
