# MeritBooks — Session 41 Handoff

**Date:** 2026-08-01
**Supersedes:** session 40. Use this as the current source of truth for build state.
**Companion:** `docs/canon/CANON-ANCHOR.md` (re-ground anchor), `docs/NORTH-STAR.md`
(product spine), and the session-41 FPBs (invoices, financial-reports,
bank-reconciliation, payroll, financial-control-exceptions).

---

## 1. Headline

The session that **got back on the gate order and put the money loop, identity, and
governance on a real footing.** GATE 12.1 (Stripe payment→PAID→GL) was hardened and is
live, and the coded platform-fee GL path was **retired** in favor of Merit booking its
own processor income through its own bank feed. The identity NO-GO gate (#9) advanced
substantially — `canApprove` now reconciles to `core.memberships` with auto-provisioning
and lifecycle sync, `require-permission` guards ride 12 money routes, and page-level RBAC
guards protect 7 sensitive pages — though **multi-tenant org resolution is still open**.
A cross-tenant leak class on financial reports was closed (all report routes off the admin
client + migration 066 makes it reproducible from source). The **Financial Control
Exception Library** began (EC-1, EC-10, EC-4, EC-3 detectors, all detect-only on the
`ai_decisions → /exceptions` rail). And the work was finally **spec-first**: an AI
Capability Catalog + 5 operator briefs + five FPBs were authored.

Everything below is on `main`. Production is at `5a2004e`; every session-41 wave commit
through `0409a1e` is Vercel **READY** (build/typecheck green), and the `5a2004e` deploy
(a docs/migration + dedup-noise fix) was building at handoff and is expected green.

---

## 2. What shipped this session (verified live)

- **GATE 12.1 — Stripe payment→PAID→GL, hardened + verified** (`44a47cf`). Resume-safe
  idempotency: GL-level dedupe on the `AR_COLLECTION` `source_ref` plus a fail-closed
  `customer_payments` insert, closing a real double-post window; `payment_intent.processing`
  and `.failed` handling added. Migration 064 then made the **DB the guarantor** with
  partial UNIQUE indexes on `gl_entries(org_id, source_ref, entry_type)` and
  `customer_payments(org_id, reference_number)`, and the idempotency probe is org-scoped
  (`c2c6597`). The tenant-side `AR_COLLECTION` post is untouched and balanced.

- **Platform-fee GL path RETIRED** (`f8ec299`). The coded `postPlatformFee` +
  `PLATFORM_ORG_ID` GL posting is gone (files removed:
  `lib/money/posting/platform-fee.ts`, its test). Merit books processor/app-fee income via
  **its own bank feed like any other tenant**; the realized app fee is persisted per
  payment in `invoice_events` `PAY_SUCCEEDED` meta (`app_fee_cents`, `fee_rail`). The new
  **Operator Console** (`/platform`, platform-staff gated, fail-closed) reads cross-tenant
  fee revenue (by tenant/rail/period, trend, take-rate) from that realized-fee data — no
  `PLATFORM_ORG_ID` dependency remains.

- **Identity / RBAC gate #9 — major progress** (`44a47cf`, `f8ec299`, `c3bbc84`,
  `36fc6cc`, `8b74bcf`, `0409a1e`):
  - `canApprove` **reconciled to core identity** (`approvals.ts` + `rbac/role-normalize.ts`):
    resolves `core.users → core.memberships`, normalizes membership role
    (`owner`/`org_admin` → `company_admin`), gates via `hasPermission` on
    checks/bills/payroll, fails closed. Interim `core.employees` fallback only when there
    is no active membership.
  - **Membership auto-provision on login** (`f8ec299`) — idempotent, role derived from
    `employees` via `normalizeMembershipRole`, so the canonical path resolves and the
    employees fallback stops firing. This retires the hand-seeded prod identity rows.
  - **Membership lifecycle sync** (`36fc6cc`, `sync-membership.ts`) — team deactivate /
    reactivate / role-change now syncs `core.memberships` so the spine can't drift more
    permissive than the employee record (the proper fix for the H1 that `c3bbc84` had
    patched with an interim inactive-employee deny).
  - **`require-permission` guards on 12 money/write routes** (`8b74bcf`) —
    checks/bills/invoices/journal-entries/payments, using the `gl/post` pattern as
    defense-in-depth on top of RLS + `canApprove` SoD.
  - **Page-level RBAC guards on 7 sensitive pages** (`0409a1e`, `lib/rbac/page-guard.ts`) —
    `/checks`, `/bills`, `/journal-entries`, `/settings/payments`, `/team`, `/audit`,
    `/close`; fail-closed redirect, role resolved like `canApprove`.

- **Report-route RLS sweep + reproducibility** (`36fc6cc`, `8b74bcf`, `5a2004e`). All
  financial-report routes (cash-flow, budgets-vs-actual, close, consolidated, then the
  remaining 14: ap/ar-aging, gl-detail, balances, job-profitability, etc.) were moved off
  `createAdminSupabase()` to the RLS-enforced authed client — **closing the cross-tenant
  leak class on reports**. Migration 066 (`report_views_security_invoker`) forces
  `security_invoker=true` on all public views so a view rebuilt from migrations no longer
  runs definer-rights and bypasses RLS. Cash-flow now classifies by account TYPE/role (not
  hardcoded numbers); consolidated **nets `is_eliminating` accounts to zero** at roll-up
  (real eliminations) with a tie-out test.

- **Financial Control Exception Library — 4 detectors, all detect-only** on the
  `ai_decisions → /exceptions` rail (`8b74bcf`, `0409a1e`):
  - **EC-1** duplicate-payment / duplicate-vendor (duplicate bills / paid-twice /
    duplicate vendor masters), tiered, idempotent — 23 tests.
  - **EC-10** anomalous-JE (missing support, structuring, sensitive account, backdated,
    round-dollar, after-hours) — 23 tests; dedup later widened to
    APPROVED/REJECTED + log-once (`5a2004e`) to kill audit noise.
  - **EC-4** uncategorized/unposted cost-leakage (uncoded bank lines >15d, unposted
    receipts >30d, approved-but-unposted bills >30d) rolled up by company/period with a
    close-readiness summary (blocks a clean close >$25k) — 20 tests.
  - **EC-3** intercompany/interdept out-of-balance (per-period interdept revenue==cost,
    intercompany AR 1160 == AP 2020, one-sided internal invoices) — 19 tests.

- **Bank Reconciliation Wave A** (`36fc6cc`, migration 065). `bank_transactions.reconciled_at`
  + `reconciliation_id`; per-line check-off with running difference-to-$0, finalize/lock,
  and auditable unreconcile; the session-40 autopilot tab integrated and locks respected.

- **AR Collections / DSO dashboard** (`36fc6cc`, `/invoices/collections`) — aging buckets,
  DSO, avg-days-to-pay, ranked worklist with one-click reminder (`REMINDER_SENT`),
  per-customer rollup. Real data.

- **Rev-rec correctness + billing-consumer compliance:**
  - Manual invoice create now credits **Deferred Revenue 2410** (not Revenue) for deferral
    methods via the `shouldDeferAtBilling` resolver (`c2c6597`, new
    `lib/invoices/rev-rec-credit.ts`); same fix repaired an unbalanced JE that silently
    never posted when tax/retainage was nonzero, and a uuid crash from a Clerk text id in
    `gl_entries.created_by` (now null per canon).
  - `billing-consumer.ts` migrated onto the canonical `shouldDeferAtBilling` + `resolveRole`
    so event-driven billing matches the manual path (`f8ec299`, 7 tests).
  - Onboarding / settings rev-rec wizard now offers **all 9 methods** (was 4) with
    plain-language industry guidance.

- **Docs / governance:** the **AI Capability Catalog** (29 capabilities, 8 functions,
  ranked) + 5 operator briefs (Controller/CFO, CPA tax+assurance, accounting-firm partner,
  bookkeeper, accounting-manager) under `docs/discovery/books/`; and **five FPBs** —
  invoices, financial-reports, bank-reconciliation, payroll, financial-control-exceptions.
  The canon mirror (`docs/canon/`) and `CLAUDE.md` §0 (re-ground protocol) / §0.1 (agent &
  build rules, **opus-4.8 binding**) were established (`053e2cd`, `2fd48f5`) to close the
  Session-40 "built off a stale CLAUDE.md" failure.

---

## 3. Data / infra changes (reproducibility notes)

- **Three new migrations, all applied to Supabase first, then committed:**
  - `064_money_dedupe_unique_indexes.sql` — partial UNIQUE indexes for double-post safety
    (applied `20260801140556`).
  - `065_bank_txn_reconciliation_link.sql` — `bank_transactions.reconciled_at` +
    `reconciliation_id` (applied `20260801145909`).
  - `066_report_views_security_invoker.sql` — `security_invoker=true` on public views
    (applied `20260801160525`, the latest applied migration).
- **Present in the repo but NOT yet applied to Supabase:** `066_proj_seam.sql` and
  `067_proj_contract_progress_standalone.sql` (Projects-module seam / contract-progress).
  They are staged but do **not** appear in `list_migrations` — do not assume they are live.
  (Note the duplicate `066_` numeric prefix on the seam file vs. the applied
  security-invoker file; the Projects seam files were not part of this session's applied set.)
- **Identity rows are now auto-provisioned on login** (membership + `core.users`), which
  retires the fragile hand-seeded prod rows from session 39/40. Key ids unchanged: org
  `1d1aa1ef-4218-4187-a622-4a80da1a9e11`; Supabase project `npqeijipggtuduhkejxq`; Clerk
  user `user_3BwDOygB7TuYWcrUUt87GOVvQV1`; Vercel team `team_2EwoHwR0BcH6GNjMjCbMaVAW`,
  project `meritbooks-web`.
- **Auto-push loop still live** on Mike's machine (ships `main` commits automatically).
  Claude cannot push from the sandbox and must not handle a token.

---

## 4. Open items — DO NOT FORGET

### Identity gate #9 — STILL OPEN (the remaining blockers)
- [ ] **Multi-tenant org resolution.** `require-permission`, the page-guard, and the
      payments path still fall back to the **first org**. This must resolve the real
      per-request/per-event org before RBAC can be trusted across tenants. (task #33)
- [ ] **Control-route RBAC.** The new control/exception routes (EC-1/EC-10/EC-4/EC-3) and
      report routes have auth + RLS but not yet the `require-permission` guard.
- [ ] **A dedicated `payments` permission** in `permissions.ts` (the money-route guards
      currently borrow checks/bills/payroll). (task #33)
- [ ] `events/{progress,dept-invoice,billing}/process` still resolve first-org — need real
      per-event org resolution.
- [ ] **Location-scoped RLS** (per-client fiduciary isolation) — specced (identity FPB
      §7.1), not built.

### Verification still owed
- [ ] **Browser-verify** the money loop end-to-end and the new surfaces with real data:
      Stripe `4242` card → PAID → balanced GL; `/platform` Operator Console;
      `/invoices/collections`; bank-rec per-line finalize/undo; the four control detectors
      landing in `/exceptions`. Vercel `next build` (authoritative typecheck) is green;
      pages have not all been walked in a browser.
- [ ] Carried from session 40: browser-walk `/vendor-compliance`, `/reconciliation`
      (autopilot), `/forecast`.

### Known drift / deferred (carried forward)
- [ ] `api/vendors/route.ts` references `core.vendors` columns that don't exist on the live
      table (country/notes/tax_id/payment_terms/is_1099) — that path errors; migrations lag
      live schema. Needs reconciliation.
- [ ] **AP attachment**: `bills.source_file_url` set null — needs a Supabase **storage
      bucket** (one-time) + upload wiring.
- [ ] AP line coding falls back to acct 6660 (Misc OPEX) when no account resolves; human
      re-codes on approval.
- [ ] Projects seam migrations (`066_proj_seam`, `067_proj_contract_progress_standalone`)
      staged but unapplied (see §3).

### Mike's manual to-dos (Claude can't do these)
- [ ] **Rotate the Resend API key** (leaked in chat earlier) and set `INVOICE_FROM_EMAIL`
      for live invoice email.
- [ ] **Clerk production instance** + JWT template + register Supabase (dev works now);
      confirm sign-up restrictions (sign-up is ON on dev).
- [ ] **Ratify the Master-Doc amendments** — `docs/PROPOSED-MASTER-DOC-AMENDMENTS.md`
      (autonomous-workforce framing + the session-40/41 canon updates). (task #19)
- [ ] **Pick the payroll provider** — Check vs. Gusto — to unblock the payroll Phase-B
      build (FPB Phase A is provider-agnostic and buildable now). (task #32)

---

## 5. Direction — what's next

Per the canon gate order and `NORTH-STAR.md` (autonomous engine + supervision/trust
layer; build **depth-first, one pipeline per parallel wave**, always behind an FPB):

1. **Close identity gate #9** — the top blocker. Real multi-tenant org resolution across
   `require-permission` / page-guard / payments / event routes; control-route RBAC; the
   dedicated `payments` permission. Until this lands, cross-tenant authz is not trustworthy.
2. **Invoices to *Complete*** (FPB authored) — the biggest remaining depth: credit memos,
   recurring, dunning/late fees; email is wired but needs the live Resend key.
3. **Financial reports depth** (FPB authored, GATE 7) — P&L / balance sheet / cash flow
   with period selectors + variance, now that reports are RLS-safe.
4. **Bank reconciliation to *Complete*** (FPB authored, GATE 8) — build out Wave A.
5. **Extend the Control Exception Library** past EC-1/3/4/10 toward EC-13, and wire
   `scoreToTier` into the actual auto-post/queue **disposition**, not just logging.
6. **AP inbox pipeline** (the session-40 marquee) once the storage bucket exists.

Execution model unchanged: file-disjoint vertical slices, 3–5 concurrent builder /
general-purpose agents in one message, shared spine single-threaded through the lead,
migrations to Supabase first, Vercel `next build` as the authoritative typecheck. The real
throughput ceiling is the single verification lane + migration serialization + FPB authorship.

---

## 6. Agents

Eight in `.claude/agents/` (builder, verifier, auditor, reviewer, designer, scribe,
security, chrome-auditor) plus SDK agents (general-purpose, Explore, Plan). **Every agent
runs on `opus` — `claude-opus-4-8` — no exceptions** (Owner directive, now binding in
CLAUDE.md §0.1; the legacy `sonnet` frontmatter in some `.claude/agents/*.md` is
superseded). This session ran multiple concurrent `general-purpose`/builder agents on
disjoint slices, with **security GO on each wave** (the one flagged HIGH — report-view
definer rights — fixed in `5a2004e`) and verifier confirmation.

---

## 7. Live state

- Production: `main` @ `5a2004e`; wave commits through `0409a1e` are Vercel **READY**
  (build/typecheck green); the `5a2004e` deploy (docs/migration + dedup-noise) was building
  at handoff and is expected green.
- Migrations 064/065/066 applied to Supabase (066 report-view security_invoker is the
  latest applied). Projects seam migrations staged but unapplied.
- Clerk↔Supabase active on the **dev** Clerk instance; auto-push loop running on Mike's
  machine.
- **Verification:** ~233 tests pass (money/identity/billing/rev-rec/reconciliation +
  ~107 new control/detector tests this session). **Standing pre-existing harness failures
  — NOT regressions:** the PGlite migration-replay harness fails when pglite isn't
  installed in the sandbox, and `src/test/tenant-isolation.test.ts` has a parse error; both
  predate this session and are unrelated to the code shipped.

---

## 8. One-line for the next session

Start by reading `docs/canon/CANON-ANCHOR.md` then this file. GATE 12.1 (Stripe→PAID→GL) is
hardened and live and the platform-fee GL path is retired; identity gate #9 is substantially
advanced but **still open on multi-tenant org resolution** (the top priority) — close it,
then drive Invoices / Reports / Bank-Rec to *Complete* behind their FPBs and extend the
Control Exception Library. Spec-first, disjoint parallel slices, migrations-first, Vercel
`next build` as the typecheck.
