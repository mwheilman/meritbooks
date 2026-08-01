# MeritBooks — Session 40 Handoff

**Date:** 2026-08-01
**Supersedes:** session 39. Use this as the current source of truth for build state.
**Companion:** `docs/NORTH-STAR.md` (the product spine) and
`docs/FPB-tenant-model-consolidation-analytics.md`.

---

## 1. Headline

Two things this session. First, the **money-approval layer is unblocked**: the
check/bill/payroll approval path was failing closed against a `core.roles` table
that was never built; it now resolves authority from the same `core.employees.role`
the rest of the app already trusts, so a `company_admin` can actually approve.
Second, we proved the **parallel-agent execution model**: three file-disjoint
verticals — **Vendor Compliance risk engine**, **Reconciliation autopilot**, and the
**13-Week Cash Forecast** — were built concurrently by three builder agents in ~11
minutes wall-clock, integrated centrally, and shipped. The **auto-push loop** now
runs on Mike's machine, so the recurring manual `git push` gate is gone.

Everything below is on `main` and **live in production** (`95b52b2`, Vercel state
READY — meaning `next build`, the authoritative full-project typecheck, passed).

---

## 2. What shipped this session (all merged to `main`, production READY)

- **Approvals authority fix** (`614157a`). `canApprove()` in
  `apps/web/src/lib/money/approvals.ts` used to query `core.memberships` joined to a
  nonexistent `core.roles` table on an undefined `approve_money_movement` key → it
  always errored → every check/money approval 403'd. Now it reads
  `core.employees.role` (RLS `org_isolation`, so any member can read their own row)
  and grants money-movement approval when the role can approve on any money surface
  (`hasPermission(role, 'checks'|'bills'|'payroll', 'approve')`). Separation of
  duties is unchanged (the `approve()` guard + a DB CHECK). Stale error message
  updated. This lights up the `/checks` **Check Run** approve button end-to-end.

- **Parallel wave** (`95b52b2`) — three concurrent verticals, shared spine reserved:
  - **Vendor Compliance risk engine** (`lib/compliance/risk.ts` + `assess.ts`,
    `/vendor-compliance`, `api/vendor-compliance/route.ts`). Pure risk engine scores
    each vendor from worst COI/W9 doc state + open-AP exposure, runs it through
    `scoreToTier` (auto/review/escalate), **logs an AI action per vendor** to
    `core.action_log`, and **escalates** on-hold high-risk vendors into `/exceptions`
    by inserting `PROPOSED` rows into `public.ai_decisions` (deduped, idempotent). The
    page gained doc-state + enforcement summary strips, filter chips, a sortable AI
    risk column with tier/confidence chips, visible expiry dates, and an error state.
  - **Reconciliation autopilot** (`lib/services/reconciliation-match.ts` + tests,
    `api/reconciliation/autopilot` + `/autopilot/match`,
    `reconciliation-autopilot.tsx`, `reconciliation-tabs.tsx`). A pure composite
    scorer (Vendor 40% + Amount 40% + Date 20%) proposes bank↔bill / bank↔vendor-
    pattern matches with confidence tiers; **Accept** stages a clean AP settlement
    (writes `matched_bill_id/match_type/match_confidence` exactly as
    `/api/bank-feed/approve` reads to clear AP instead of re-expensing); **Reject**
    FLAGs the txn into `/exceptions`. AI proposal + human decision both logged.
    Auto-clear button clears all auto-tier proposals at once. The existing
    statement-vs-GL reconciliation is preserved under a second tab.
  - **13-Week Cash Forecast** (`lib/cash/forecast.ts` + tests, `api/forecast`,
    `forecast-grid.tsx`). Real projection off bank balances + open AR/AP by due date:
    weekly opening→net→closing, low-water mark, negative-week flags, per-week
    drill-down to the driving invoices/bills, inline SVG chart, company selector +
    consolidated toggle. Replaces a hardcoded-all-zeros mockup (a Rule 4 violation).

- **Two real bugs fixed in passing (found by the agents):**
  - **RLS leak on `/api/cash`**: it was bypassing RLS via the admin client +
    `v_cash_position` view. Rewritten to `requireAuthedContext` querying
    `bank_accounts` + `core.locations` directly, response shape preserved so the
    dashboard keeps working. (Isolation win — belongs to task #9.)
  - **`NOT NULL` crash on statement reconciliation**: the existing statement-recon
    POST never set `bank_reconciliations.statement_date` (NOT NULL, no default,
    migration 007) and would 500 every insert. Now set to the period `end_date`.

- **(Late session 39 carry, now on prod, documented here for completeness):**
  `09c5b96` Operations "client health + intervention flags" (per-company backlog +
  ranked manager-attention list on `/operations`), and `3e060db` Check Run (tee up
  due bills into the approval queue — prepare + SoD approve only, never releases or
  posts).

---

## 3. Data / infra changes (reproducibility notes)

- **No new migrations this session.** The parallel wave used only existing tables
  (verified against the migration SQL before querying). The two schema needs the
  agents surfaced were *not* invented — they're recorded in §4 for a future central
  migration.
- **Auto-push loop is live on Mike's machine** (a `while` loop that `git push`es
  `~/Projects/meritbooks` every ~30s using his own credentials). This removes the
  recurring manual push gate. Claude cannot push from the sandbox (no credentials,
  ephemeral) and must not handle a token — the loop is the sanctioned mechanism.
- Still true from session 39 §3: Mike's identity rows (`core.users`,
  `core.memberships`, `core.membership_locations`, `core.employees` as
  `company_admin`) were seeded **directly to prod**, not in a migration/seed. If the
  DB is reset they vanish; the durable fix is auto-provisioning (see §4). Key ids:
  org `1d1aa1ef-4218-4187-a622-4a80da1a9e11`; Supabase project `npqeijipggtuduhkejxq`;
  Clerk user `user_3BwDOygB7TuYWcrUUt87GOVvQV1`; Vercel team
  `team_2EwoHwR0BcH6GNjMjCbMaVAW`, project `meritbooks-web`.

---

## 4. Open items — DO NOT FORGET

### Mike's manual to-dos (Claude can't do these)
- [ ] **Rotate the Resend API key** leaked in chat earlier. Security.
- [ ] **Clerk production instance** + JWT template + register Supabase (dev works now).
- [ ] Confirm **Clerk sign-up restrictions** (sign-up is ON on dev).
- [x] ~~Recurring `git push`~~ — replaced by the auto-push loop.

### Verification still owed on this session's work
- [ ] **Browser-verify the three new verticals** (`/vendor-compliance`,
      `/reconciliation` autopilot tab, `/forecast`). The production **build passed**
      (full typecheck clean) and 22 new unit tests + 150 total pass, but the pages
      have **not yet been walked in a browser** with real data. This is the next
      concrete QA step. (Local `tsc` could not complete in the build sandbox — too
      memory-starved to finish and background jobs don't survive; Vercel's
      `next build` is the authoritative typecheck and it is green.)

### Security task #9 remainder (isolation done; these are non-blocking)
- [ ] **RBAC `requirePermission` guard rollout.** Only `gl/post` is guarded. The new
      autopilot / forecast / reconciliation routes have auth + RLS but no
      permission guard. `canApprove` now aligns to `employees.role`, but the
      `require-permission.ts` guard should still be rolled across money routes.
- [ ] `events/{progress,dept-invoice,billing}/process` still resolve first-org — need
      real per-event org resolution.
- [ ] `PLATFORM_ORG_ID` unset → MeritBooks' own platform-fee revenue doesn't post.

### Identity debt (foundational)
- [ ] **Reconcile the two role systems + auto-provision on login.** The app reads
      `core.employees`; the plane switcher reads `core.users`/`memberships`.
      `canApprove` now reads `employees` (consistent with the app), but the fork
      still exists. Auto-provisioning removes the hand-seeding in §3.
- [ ] **Location-scoped RLS** (per-client fiduciary isolation) — specced (FPB §7.1),
      not built.

### Known drift / deferred (carried forward)
- [ ] `api/vendors/route.ts` references `core.vendors` columns that don't exist on the
      live table (country/notes/tax_id/payment_terms/is_1099) — that path errors;
      migrations lag the live schema. Needs reconciliation.
- [ ] **AP attachment**: `bills.source_file_url` set null — attaching the source
      invoice needs a Supabase **storage bucket** (one-time) + upload wiring.
- [ ] AP line coding falls back to acct 6660 (Misc OPEX) when no account resolves;
      human re-codes on approval.

### From the parallel wave (surfaced by the agents, optional central changes)
- [ ] Vendor-compliance escalations currently surface under the generic `ai_proposal`
      exception source (deep-links to `/ai-decisions`). A first-class "Vendor
      compliance" source + deep link to `/vendor-compliance` would touch the shared
      `api/exceptions/route.ts` (spine, reserved). Works today.
- [ ] Reconciliation models "cleared" as `status='POSTED' && gl_entry_id set` (the real
      book-hit signal) rather than an explicit `bank_transactions.reconciled_at` /
      `reconciliation_id`. If the product wants a first-class reconciled flag, that's a
      central migration. Also: reverse-direction book-only in-transit items (manual JEs,
      Stripe AR_COLLECTION) aren't surfaced yet; the window is period-bounded.
- [ ] Forecast does not yet model payroll, taxes, or recurring transfers (the UI says
      so rather than faking it).

---

## 5. Direction — what's next

Per `NORTH-STAR.md`: the product is the **autonomous engine + supervision/trust
layer**; build **depth-first, one pipeline at a time**, now via **parallel waves**.

**Execution model (proven this session):** carve work into **file-disjoint**
vertical slices; launch one builder agent per slice concurrently; keep the shared
spine single-threaded through the lead (migrations, `packages/shared`,
`api-handler`, `navigation.ts`, `rbac/permissions.ts`); agents never run git and
never invent schema — they report needs; the lead integrates, runs unit tests, and
lets Vercel's `next build` be the authoritative typecheck (it fails closed, so a
type error blocks the deploy rather than reaching prod). The real bottleneck is the
single verification lane, not the number of builders.

**Next waves (candidate, all reasonably file-disjoint):**
1. **AP inbox pipeline** — the marquee: ingest email → AI extract → vendor
   auto-create → bill PENDING/ON_HOLD by tier → attach source (needs the storage
   bucket) → land in the exception queue. `lib/ap/intake.ts` already does extract →
   vendor resolve-or-create → tiered bill; extend it into the full loop.
2. **Reports / financial statements depth** — P&L / balance sheet / cash flow with
   period selectors + variance (read-only, self-contained).
3. **Intercompany** — internal invoices / eliminations depth.
4. **Cross-cutting:** wire `scoreToTier` into the actual posting/approve *disposition*
   (auto-post high-confidence, queue the rest) — not just logging; and the RBAC guard
   rollout above.

---

## 6. Agents

Eight in `.claude/agents/`: builder, verifier, auditor, reviewer, designer, scribe,
security, chrome-auditor. This session also used ad-hoc `general-purpose` builder
agents run **concurrently** on disjoint verticals — the pattern in §5.

---

## 7. Live state

- Production: `main` @ `95b52b2`, Vercel deployment READY (build/typecheck green).
- Approvals fix `614157a` and the wave `95b52b2` both deployed to production.
- Clerk↔Supabase integration active on the **dev** Clerk instance.
- Auto-push loop running on Mike's machine (commits ship automatically).
- Verified this session: 22 new unit tests (composite scorer + forecast engine) +
  150 total pass; all cross-module imports/exports, API↔UI shapes, and page wiring
  hand-checked; production `next build` passed. **Not yet** browser-verified (see §4).

---

## 8. One-line for the next session

Start by reading this file. The money-approval path and three new pipelines are live
and typecheck-clean; the immediate next step is a **browser walk of
`/vendor-compliance`, `/reconciliation`, and `/forecast`** with real data, then the
**AP inbox pipeline** as the next parallel wave. Shared spine stays single-threaded
through the lead; agents build disjoint slices; Vercel `next build` is the typecheck.
