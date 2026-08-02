# MeritBooks — Session 44 Handoff

**Date:** 2026-08-02
**Supersedes:** session 43. Use this as the current source of truth for build state.
**Companion:** `docs/canon/CANON-ANCHOR.md` (re-ground anchor), `docs/NORTH-STAR.md`
(product spine), the AI-capability master (`docs/discovery/AI-CAPABILITY-MATRIX.md` +
`INTEGRATION-MAP.md`), and the FPBs (invoices, financial-reports, bank-reconciliation,
payroll, financial-control-exceptions, team-performance, identity-multitenancy,
tenant-model-consolidation-analytics, payments-fees, nl-copilot).

> **Coordination note (read first):** two Cowork sessions commit to this one repo —
> **MeritBooks** (this handoff) and **MeritProjects** (Module 6, the `feat(projects): …`
> commits). Disjoint workstreams sharing one git history, one Supabase, one migration
> sequence. Rules in force: **path-scoped `git add`** (never `git add -A`), and **disjoint
> migration bands — Books `0xx`, Projects `1xxx`.** In this handoff, ignore the `projects`
> commits (`3bcdf28`, `61aef7a`) except where they touch the shared spine. Note the Projects
> workstream also landed **security hotfix migration `1006`** (`proj_security_org_scoping`).

---

## 1. Headline

The session that **converted the AI-capability matrix into breadth AND drove the five thin
segments toward real depth**, while **hardening the money/identity seam**. Session 43 proved
the surface (14-modality × 24-segment matrix) and filled the biggest AI-modality blanks;
Session 44 (a) opened the last untouched modality — **M14 learning** — with a vendor→GL
categorization-memory engine, (b) extended the **Universal NL Command + FP&A Copilot** (the
⌘K bar, the allowlisted analytical lane, the P1–P4 processing lanes) and **M7 narrative**
across **all four statements** plus **M13 search**, (c) put the **M10 autonomy plane
(migration 075)** to work across **10 detectors**, (d) hardened RBAC with a **dedicated
`payments` money-movement permission** now gating payments / payroll-release / checks-run,
an **`/api/accounts` RLS-scope fix**, and **5 direct-key reads routed through the Core AI
gateway helper**, and (e) shipped real depth in the previously-thin segments —
**consolidation, job costing, fixed assets, customer management, book-to-tax, onboarding
conversion, AP doc-intake, covenant monitor, purchase orders + 3-way match, sales-tax
return, AR collections, driver-based budgeting/reforecast, board-package generator, and a
cash-application apply path.**

Everything below is on `main`. **Production HEAD is `5fd3b0d`** (`chore(nav): add Purchase
Orders, Sales Tax Return, Collections, Driver Budget, Reforecast, Board Package`); every
Books wave commit built on the auto-push → Vercel `next build` loop (the authoritative
full-project typecheck). Migrations **075–080** were applied to Supabase first, then the
dependent code committed.

---

## 2. What shipped this session (Books)

### AI surface — breadth across modalities

- **M14 learning (the last open column) — OPENED** (`15d8406`): a **vendor categorization
  memory** engine that learns each tenant's vendor→GL coding from **approved** history and
  proposes the account on the next transaction. This was the largest whole-column blind spot
  the 14×24 matrix exposed; it now has a first deterministic engine (proposes → human
  approves; canon SoD intact).
- **Universal NL Command + FP&A Copilot (M8)** — the ⌘K bar, intent router, the **analytical
  allowlist** lane (model never writes SQL; abstains outside the catalog), and **processing
  lanes P1–P4** (P1 command / P2 categorize / P3 draft-bill / P4 draft-invoice, each
  propose→approve) carried and extended from the session-43 base.
- **M7 narrative across all four statements** — deterministic driver computation picks the
  movers; the model only turns numbers into phrases. Live on **P&L, balance sheet, cash
  flow, and budget-vs-actual.**
- **M13 search** — `/search` plain-English find-anything over the ledger (invoices, bills,
  JEs, vendors, accounts).
- **M10 autonomy plane (migration 075) wired into 10 detectors** — every control-exception
  proposal records a per-feature disposition (auto / queue / hold) honoring the tenant's
  autonomy dial + global kill switch, surfaced on `/exceptions`.

### Money / identity HARDENING (gate #9 residual)

- **Dedicated `payments` money-movement permission** (`5da6660`, `b6d39ff`) added to
  `apps/web/src/lib/rbac/permissions.ts` (`{ id: 'payments', … internalOnly: true }`). It now
  gates **payments, payroll-release, and checks-run** — previously these routes borrowed
  `checks`/`bills`/`payroll`/`journal_entries:create`.
- **`/api/accounts` RLS-scope fix** (`b6d39ff`) — the accounts route is now org-scoped (was
  leaking cross-tenant).
- **5 direct-Anthropic key reads routed through the Core AI gateway helper** (`b6d39ff`,
  `8c48bbd` base) — single centralized key reader; every AI call meters to
  `core.ai_usage_log` and respects the combined-suite tenant budget (canon §2 invariant).
- **Payment-run fraud screen** (session-43 base, carried) — new-payee / BEC / unusual-amount
  / duplicate checks; detect-only, blocks a duplicate pay, never releases money autonomously.
- **Residual (task #56):** split the single `payments` permission into **per-route money
  keys** so a `check_processor` can regain **check-run** without also holding
  **payroll-release** (currently one permission grants both).

### Thin-segment DEPTH (behind their FPBs)

- **Consolidation — GATE 11a** (migration 076): multi-entity consolidated financials with
  **ownership %, NCI, and intercompany eliminations**.
- **Job costing** — **EAC cost-to-complete forecast** + **WIP over/under-billing schedule**.
- **Fixed assets** (migration 079): depreciation **methods selectable** (150% declining
  balance / SYD / units-of-production), **disposal gain/loss resolved by account role**, and
  an asset **roll-forward** (the method enum + disposal roles formalized in `079`).
- **Customer management** — **duplicate detection + merge** (jobs repointed to the surviving
  customer on merge) + a **credit/risk dossier** per customer.
- **Book-to-tax — TX-C1** (migration 077): **M-1 / M-3 book-to-tax tagging** + a **Schedule
  M-1 reconciliation** (migration references `core.organizations`, not a bare `organizations`
  table — fixed in `b4f3788`).
- **Onboarding — historical conversion pipeline**: **AI-mapped opening trial balance**, a
  **human tie-out gate**, and a **balanced go-live post**.
- **AP document-intake** (`e9b8c9c`): a **provider-agnostic** AP doc-reading intake queue
  (Azure-ready; awaiting GATE 4 creds).
- **Covenant monitor** (migration 078): **DSCR / FCCR / leverage** breach monitor —
  ledger-computed headroom, forecast-projected breach date, and an **AI-drafted compliance
  certificate**.
- **Purchase orders + 3-way match — GATE 11b** (migration 080): AP **purchase orders + goods
  receipts + 3-way match** (PO ↔ receipt ↔ bill).
- **Sales-tax return prep** — per-jurisdiction liability worksheet + **GL tie-out** + nexus
  cross-reference.
- **AR collections** — collections workflow + **dunning cadence**.
- **Driver-based budgeting + rolling reforecast** — driver model + reforecast.
- **Board-package generator** — board-ready financial package + notes generator with
  **branded PDF export**.
- **Cash-application apply** (`7897cbf`): a **human-approved AR cash-application apply** path
  + **AR subledger ↔ GL tie-out**.

---

## 3. Data / infra changes (reproducibility notes)

- **Books migrations applied to Supabase this session (Supabase first, then code):**
  - `075_autonomy_control_plane.sql` — per-feature autonomy dial + global kill switch (RLS).
  - `076_consolidation_ownership.sql` — entity ownership %, NCI, elimination mappings (RLS).
  - `077_book_tax_differences.sql` — M-1/M-3 book-to-tax tagging (references `core.organizations`).
  - `078_loan_covenants.sql` — covenant definitions + measured headroom.
  - `079_fixed_asset_methods.sql` — depreciation-method enum + disposal gain/loss account roles.
  - `080_purchase_orders.sql` — purchase orders + goods receipts + 3-way match.
- Session-42/43 Books migrations `064–065`, `068–076` (no `072`) remain applied. **The
  sequence still skips `072`.** Projects `066/067` + `1001–1006` are applied by the
  MeritProjects workstream — Books does not own them. **Note:** the Projects **security
  hotfix migration `1006`** (`proj_security_org_scoping`) landed this session too.
- **Nav gained ~14 entries** across the wave integrations: Search, AI Autonomy, Consolidation
  (s43 carry) plus **AP Intake, Covenant Monitor, Book-to-Tax, Historical Conversion, Cash
  Application, Job WIP, Purchase Orders, Sales Tax Return, Collections, Driver Budget,
  Reforecast, Board Package.**
- **New tests** landed across all the pure engines this session (M14 vendor-memory,
  consolidation ownership/NCI/elim, job-cost EAC/WIP, fixed-asset methods/disposal
  roll-forward, book-to-tax M-1, covenant headroom, PO 3-way match, sales-tax tie-out,
  cash-application apply, driver budgeting). The standing pre-existing harness failures are
  unchanged and are **NOT regressions:** the PGlite migration-replay harness fails when
  pglite isn't installed in the sandbox, and `src/test/tenant-isolation.test.ts` has a parse
  error — both predate session 42.
- **Key ids unchanged:** org `1d1aa1ef-4218-4187-a622-4a80da1a9e11`; Supabase project
  `npqeijipggtuduhkejxq`; Clerk user `user_3BwDOygB7TuYWcrUUt87GOVvQV1`; Vercel team
  `team_2EwoHwR0BcH6GNjMjCbMaVAW`, project `meritbooks-web`.
- **Auto-push loop still live** on Mike's machine (ships `main` commits automatically). Claude
  cannot push from the sandbox and must not handle a token.

---

## 4. Open items — DO NOT FORGET

### This session's follow-ups
- [ ] **Per-route money permissions (task #56)** — split the single `payments` permission into
      per-route keys so a `check_processor` regains **check-run** without **payroll-release**.
- [ ] **Verifier follow-ups (task #52)** — outstanding verifier notes on the wave builds.

### Still-open gates
- [ ] **Identity gate #9 — residual** (org resolution + `payments` permission are DONE; these
      remain, and several are **MANUAL for Mike**): stand up the **Clerk production instance**
      and add the **`org_id` claim** so the first-org fallbacks can be dropped; set
      **`EVENT_WORKER_SECRET`**; rotate the **Resend key**. Plus (Claude-side) `core.assignments`
      per-user scoping, event-worker read/"peek" scoping, and location-scoped RLS.
- [ ] **Payroll GATE 12.3 Phase B** (task #34, blocked on provider pick): releaser ≠ preparer
      at release, payroll double-post guard, live Check sandbox.
- [ ] **GATE 4 — AP OCR / email ingestion** (blocked on **Azure creds** from IT; the
      provider-agnostic AP intake queue is built and Azure-ready).
- [ ] **Practice / multi-client plane** still needs **cross-tenant identity** before it can be built.

### Known drift / deferred (carried forward)
- [ ] Invoice write-off needs a **`BAD_DEBT_EXPENSE` account role** + `v_ar_aging` to exclude
      `WRITTEN_OFF`.
- [ ] `api/vendors/route.ts` references `core.vendors` columns not on the live table — that
      path errors.
- [ ] **AP attachment**: `bills.source_file_url` null — needs a Supabase storage bucket + upload.
- [ ] AP line coding falls back to acct 6660 (Misc OPEX) when no account resolves.

### Mike's manual to-dos (Claude can't do these)
- [ ] **Ratify the Master-Doc amendments** — `docs/PROPOSED-MASTER-DOC-AMENDMENTS.md` (task #19).
- [ ] **Pick the payroll provider** — Check vs. Gusto — to unblock Payroll Phase B (task #32,
      leaning Check).
- [ ] **Rotate the Resend API key** + set **`INVOICE_FROM_EMAIL`** for live invoice/statement email.
- [ ] **Clerk production instance** + JWT template (with `org_id` claim) + register Supabase.
- [ ] **Set `EVENT_WORKER_SECRET`** (the event-worker auth guard's constant-time header secret).
- [ ] **Provide Azure creds** to unblock GATE 4 AP-OCR / email ingestion.

---

## 5. Direction — what's next

Per the canon gate order and `NORTH-STAR.md` (autonomous engine + supervision/trust layer;
depth-first, one pipeline per parallel wave, behind an FPB):

1. **Close the identity gate #9 residual** — the MANUAL Clerk-prod + `org_id`-claim work
   (drops the first-org fallbacks), `EVENT_WORKER_SECRET`, Resend key; then per-route money
   permissions (task #56), `core.assignments`, event-worker read-scoping, location-scoped RLS.
2. **Polish the newly-deepened segments** against their follow-ups — consolidation, job
   costing, fixed assets, customer mgmt, book-to-tax, onboarding, covenants, POs.
3. **Payroll Phase B** once the provider is picked (releaser ≠ preparer, double-post guard,
   live Check).
4. **Extend the control library toward EC-1..EC-13** and let the autonomy plane govern more
   dispositions.
5. **Grow the M14 learning column** beyond vendor-memory (the modality is now opened, not full).

Execution model unchanged: file-disjoint vertical slices, 3–5 concurrent builder/general-purpose
agents (all **opus 4.8**) in one message, shared spine single-threaded through the lead,
migrations to Supabase first, Vercel `next build` as the authoritative typecheck. **Two
concurrent workstreams (MeritBooks + MeritProjects) share the repo — path-scoped commits +
disjoint migration bands (Books `0xx` / Projects `1xxx`) are mandatory.**

---

## 6. Agents

Eight in `.claude/agents/` (builder, verifier, auditor, reviewer, designer, scribe, security,
chrome-auditor) plus SDK agents (general-purpose, Explore, Plan). **Every agent runs on `opus` —
`claude-opus-4-8` — no exceptions** (Owner directive, binding in CLAUDE.md §0.1). This session
ran concurrent `general-purpose`/builder waves on disjoint slices (M14 learning / consolidation /
job-cost / fixed-assets / customer-mgmt / book-to-tax / onboarding / AP-intake / covenants /
POs / sales-tax / collections / budgeting / board-package / cash-application), with the RBAC/
identity hardening reviewed for the money/AI-governance seams.

---

## 7. Live state

- **Production HEAD: `main` @ `5fd3b0d`** (`chore(nav): add Purchase Orders, Sales Tax Return,
  Collections, Driver Budget, Reforecast, Board Package`). Every Books wave commit this session
  shipped via the auto-push → Vercel `next build` loop (the authoritative full-project typecheck).
- Books migrations `064–065`, `068–080` (no `072`) applied to Supabase, including this session's
  **075–080**; Projects `066/067` + `1001–1006` applied by the Projects workstream.
- Clerk↔Supabase active on the **dev** Clerk instance; auto-push loop running on Mike's machine.
- **Verification:** the deterministic-engine suites for this session's builds pass on top of the
  session-43 baseline. **Standing pre-existing harness failures — NOT regressions:** pglite not
  installed in the sandbox; `src/test/tenant-isolation.test.ts` parse error. Both predate this session.

---

## 8. One-line for the next session

Start by reading `docs/canon/CANON-ANCHOR.md` then this file. Session 44 **opened the last AI
modality (M14 learning, vendor→GL memory)**, **hardened the money/identity seam** (dedicated
`payments` permission gating payments/payroll-release/checks-run, `/api/accounts` RLS fix, 5
direct-key reads through the gateway), and **drove the thin segments to real depth** —
consolidation (11a), job costing, fixed assets (079), customer mgmt, book-to-tax (077),
onboarding conversion, AP intake, covenant monitor (078), purchase orders + 3-way match (080),
sales-tax return, AR collections, driver budgeting/reforecast, board package, cash-application
(migrations 075–080). **Next:** land the MANUAL Clerk-prod + `org_id`-claim work to close gate
#9, split money permissions per route (task #56), Payroll Phase B on provider pick, and unblock
GATE 4 with Azure creds — spec-first, disjoint parallel slices, migrations-first, path-scoped
commits alongside MeritProjects.
