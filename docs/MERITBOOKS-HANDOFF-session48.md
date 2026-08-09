# MeritBooks — Session 48 Handoff

**Date:** 2026-08-09
**Supersedes:** session 47. Use this as the current source of truth for build state.
**Companion:** `docs/canon/CANON-ANCHOR.md` (re-ground anchor), `docs/NORTH-STAR.md`
(product spine), the AI-capability master (`docs/discovery/AI-CAPABILITY-MATRIX.md` +
`INTEGRATION-MAP.md`), and the FPBs (invoices, financial-reports, bank-reconciliation,
payroll, financial-control-exceptions, team-performance, identity-multitenancy,
tenant-model-consolidation-analytics, payments-fees, nl-copilot).

> **Coordination note (read first):** two Cowork sessions commit to this one repo —
> **MeritBooks** (this handoff) and **MeritProjects** (Module 6, the `feat(projects): …`
> commits). Disjoint workstreams sharing one git history, one Supabase, one migration
> sequence. Rules in force: **path-scoped `git add`** (never `git add -A`), and **disjoint
> migration bands — Books `0xx`/`1xx` core band, Projects `1xxx`.** Ignore the `projects`
> commits except where they touch the shared spine. (This session, `e38ba48` — a Projects
> entitlement-gate fix — also applied shared migration **120**; see §3.)

---

## 1. Headline

The **practice-plane / white-label productization** session. Where Session 47 made the
product *usable and safe to run on the live URL*, Session 48 turned it into a **multi-company
practice product with a real billing model, customizable permissions, and honest behavior
while the AI account is dark.**

The arc, in order:

1. **Company-scoped processing rollout finished** — the active-company context from S47 now
   drives *everything*: budgets, reports, profitability, consolidation, board package, and a
   dozen create forms **default to the header active company**; 5 redundant in-page company
   selectors were removed; the dashboard was rebuilt as a **per-company work & status board**;
   the sidebar and processing surface stay hidden until a company is selected.
2. **Multi-company practice** (`6148af7`, migration **121**) — a "New company" create dialog
   (reuses entity-create + COA seed), invite/edit member **assigns any company** with a
   **per-company "Owns onboarding"** designation, and the Entities view shows each company's
   onboarding owner + status. **Roles/admin moved to the Practice plane only** (hidden from the
   bookkeeper Book-of-Record plane).
3. **Customizable permissions** (`6148af7` model/UI, `0eb7ba0` enforcement; migration **130**) —
   `core.custom_roles` + `core.role_permission_overrides` (org-scoped RLS), a
   `resolve-permissions.ts` merge layer (system default ⊕ org overrides, fail-closed), a
   `/settings/roles` admin page that **explains every default role in plain English** and lets
   admins create custom roles + toggle each permission. Enforcement is **wired into
   `require-permission` + page-guard via `effectivePermission()`** and is **degrade-safe** — an
   overrides-read failure falls back to the system default (never a lock-out).
4. **Operator Console real metrics + billing model** (`0eb7ba0`, `d4616bc`; migration **131**) —
   `/platform` now shows a real cross-tenant dashboard (active tenants/seats, realized processor
   fee revenue, AI/API cost from `ai_usage_log`, storage from `documents`, growth trend). A
   **per-company pricing model** (`lib/billing/pricing.ts`, pure cents: **$99** first 5 companies
   + **$59** after; **Firm $499** + tiered wholesale $59/$49/$39) drives **computed list-price
   MRR/ARR**. **Live Stripe tenant-charging is intentionally NOT wired** — MRR is labeled
   "list-price (computed) — live billing not activated." A tenant `/settings/billing` plan page
   shows plan, company count, per-company breakdown, ACH 1% / card 3% usage lines.
5. **Honesty-while-AI-is-dark + real modules** (`8cb7e8f`, `df85a16`) — the Anthropic org is
   disabled, so: **graceful AI-down** (`isAiUnavailableError` + shared notice; nl/query, nl/route,
   categorize, draft-bill, draft-invoice return a calm "AI temporarily paused" payload, not a
   raw 500); **FP&A NL what-if made real** with a clause-aware, order-independent **heuristic
   parser that works WITHOUT live AI**; **insurance premiums now actually post** (prepaid asset →
   straight-line amortization to insurance expense via the account-role engine, migration **132** —
   closes the old "insurance posts" overclaim); **consolidation FX/ASC-830 translation activated**
   (IS avg / BS closing / equity historical + CTA to equity, per-entity functional currency,
   migration **133**); a deterministic **EC-14 out-of-policy-expense detector**; and **payroll
   honesty** — the register-import→balanced JE is the honest primary path, the mock run engine
   is clearly labeled an **estimate** until a provider is connected.
6. **Launch polish** (`2c480e4`) — real zero-dependency **`.xlsx` export** (OOXML writer) for
   P&L/BS/CF/TB/aging + multi-sheet report packs; **AP inbound email-to-bill** webhook
   (`/api/webhooks/inbound-email`, shared-secret auth, tenant match by `inbound_ap_address`,
   migration **135**; degrade-safe with AI down — stores the attachment + a PENDING_PARSE draft
   so the document is never lost); **money-movement SoD completion** — 4 granular feature keys
   (`payments_execute`, `check_run`, `ap_disbursement_release`, `payroll_release`) added to the
   permissions catalog and granted to the 4 money roles so **effective access is UNCHANGED**,
   now enforced per-route and editable in `/settings/roles`; and a broad a11y/responsive polish
   sweep.
7. **Retention + security gaps closed** (`394b4dc`; migrations **112, 113**) — drop-and-parse
   routes now **store the uploaded source file to the private `documents` bucket BEFORE the AI
   step** (works even with AI disabled) and link it to the record's Attachments panel (migration
   112); `PATCH /api/ai/decisions` gated behind `flagged:resolve`; migration 113 adds a UNIQUE
   index on `bill_payments(org_id, bank_transaction_id)` so the DB guarantees against a concurrent
   double-post on the **bank-feed settlement (money-out)** path.

Everything below is on `main`. **HEAD is `2c480e4`.** The auto-push loop ships commits to
Vercel, whose `next build` is the authoritative full-project typecheck. Migrations 112, 113,
120, 121, 130, 131, 132, 133, 135 were applied to Supabase **first**, then the dependent code
committed (canon migration rule).

---

## 2. What shipped this session (Books)

Commit range `8137b2d..2c480e4` (10 Books commits; one shared-spine Projects commit `e38ba48`).

### Company-scope rollout completed (`df85a16`, `9e0e08a`)
- Budgets (Plan / Driver Builder / Reforecast), Profitability, Consolidation, Reports, Board
  Package all **default to the header active company** (with an All-entities/consolidated toggle
  where appropriate; consolidated stays **admin-only**). Clean empty + AI-down states.
- **5 redundant in-page company selectors removed** (bills / journal-entries / receipts / jobs /
  credit-cards) — they now derive from the header active company, with a persistent
  **"Working in {Company}"** indicator in the shared `PageHeader`.
- **Dashboard rebuilt** as a per-company work & status board (review / attention / proposals /
  draft-JE queues, close status, cash/AR/AP KPIs) with click-through that sets the active
  company + enters its workspace, plus a consolidated leadership strip. Deterministic.
- Active-company defaulting also added to several create forms (prepaids, intangibles, leases,
  internal-invoices, departments) + cash-forecast empty guard.

### Multi-company practice (`6148af7`, migration 121)
- "New company" create dialog (reuses entity-create + COA seed); invite/edit member assigns any
  company + a per-company **"Owns onboarding"** designation (`practice_assignments` `onboarding`
  function + PREPARER `admin_scope`); Entities view shows each company's onboarding owner + status.
- Onboarding depth (`9e0e08a`): skippable ERP-connect step; completion **pins the new company
  active** (`mb_active_company`) and enters its workspace.
- **Roles/admin (Settings & Admin) now render only in the Practice plane**, not the bookkeeper
  Book-of-Record plane; the active-company chip only renders in the Book-of-Record plane.

### Customizable permissions (`6148af7` + `0eb7ba0`, migration 130)
- `core.custom_roles` + `core.role_permission_overrides` (org-scoped RLS); `api/rbac` CRUD;
  `lib/rbac/resolve-permissions.ts` merges system defaults + org overrides fail-closed (+8 tests).
- `/settings/roles` admin page explains every default role's grants in plain English and lets
  admins create custom roles + toggle each permission.
- **Enforcement WIRED** (`0eb7ba0`): `require-permission` + page-guard resolve via
  `effectivePermission()` instead of bare `hasPermission()`. For a system role with no overrides
  this is byte-identical to before; **degrade-safe** — an overrides-read failure falls back to the
  system default (never a lock-out); only unknown/custom-not-found roles deny.

### Operator Console + billing model (`0eb7ba0`, `d4616bc`, migration 131)
- `/platform`: real cross-tenant business dashboard (platform-staff only, admin client) — active
  tenants/subscriptions, active seats, realized processor fee revenue, AI/API cost
  (`ai_usage_log`), storage usage (`documents`), 12-mo growth trend, per-tenant table.
- `lib/billing/pricing.ts` (pure, cents; +20 tests): $99 first 5 companies + $59 after; Firm
  $499 + tiered wholesale $59/$49/$39; enterprise custom/fallback. Migration 131 adds
  `core.organizations.billing_plan` + `custom_mrr_cents`.
- Subscription MRR/ARR **computed from each tenant's plan × active company count**, labeled
  "list-price MRR (computed) — live billing not activated." **Live Stripe tenant-charging
  intentionally NOT wired.**
- Tenant `/settings/billing` plan page: plan, company count, per-company cost breakdown, ARR,
  ACH 1% / card 3% usage lines; "billing activation coming soon" (no charge button).

### AI honesty + real accounting modules (`8cb7e8f`, `df85a16`)
- **Graceful AI-down**: `isAiUnavailableError` + shared `AiUnavailableNotice`; nl/query, nl/route,
  categorize, draft-bill, draft-invoice return a calm "AI temporarily paused" payload; deterministic
  paths still work. Fixed the standing `nl/route` type error.
- **FP&A NL what-if made real**: replaced the dead callout with a real inline NL input on the FP&A
  dashboard; `/api/fpna/nl-scenario` heuristic parser rewritten clause-aware + order-independent so
  it works WITHOUT live AI, with an honest "AI unavailable — used keyword model" note.
- **Insurance amortization + posting** (migration 132): premiums carried as prepaid asset,
  amortized straight-line to insurance expense, posting balanced JEs via the account-role engine
  (DR insurance expense / CR prepaid insurance) — closes the "insurance posts" overclaim.
- **Consolidation FX** (migration 133): ASC-830 current-rate translation (IS avg, BS closing,
  equity historical) with CTA to equity so it still balances; per-entity `functional_currency` on
  `core.locations` + FX transparency panel + assignment grid. Single-currency path unchanged.
- **EC-14 out-of-policy-expense detector** (deterministic) on the exception library.
- **Payroll honesty**: register-import → balanced JE is the honest primary path; the mock run
  engine is clearly labeled an estimate ("no money moves," not a tax calc) until a provider is
  connected.

### Launch polish (`2c480e4`, migration 135)
- Reports **`.xlsx` export** (zero-dependency OOXML writer) for P&L/BS/CF/TB/aging + multi-sheet
  report packs + board package; tightened scheduled-delivery UX.
- **AP inbound email-to-bill**: provider-agnostic `/api/webhooks/inbound-email` (shared-secret auth,
  tenant match by `org.inbound_ap_address`, migration 135), stores the attachment + lands a
  PENDING_PARSE intake draft (degrade-safe with AI down — the document is never lost); surfaced in
  the intake queue. Centralized email configured-vs-not status.
- **Money-movement SoD**: 4 granular feature keys (`payments_execute`, `check_run`,
  `ap_disbursement_release`, `payroll_release`) added to the permissions catalog + granted to the
  4 money roles so effective access is UNCHANGED (verified, no lock-out); enforced per-route +
  editable in `/settings/roles`. +SoD tests.
- Modal a11y (Esc / `role=dialog`), responsive tables, tabular-nums, input labels across
  customers/vendors/inventory/jobs/retainage/internal-invoices/departments/subscriptions/obligations.

### Retention + security (`394b4dc`, migrations 112, 113)
- **Source-doc retention**: drop-and-parse routes (covenants, leases, bills intake, bank statement)
  store the uploaded file to the private `documents` bucket **before** the AI step and link it to
  the record's Attachments panel. New `lib/documents/store-source.ts`; migration 112 records the
  bucket + org-scoped storage RLS.
- **Security**: `PATCH /api/ai/decisions` was auth-only → now gated `flagged:resolve`. Migration
  113 adds a UNIQUE index on `bill_payments(org_id, bank_transaction_id)` — the DB is the guarantor
  against a concurrent double-post on the **money-out** bank-settlement path (money-in dup was
  already covered by mig 064). Verified: direct-key reads already centralized via
  `getAnthropicApiKey`; `/api/accounts` already org-scoped.

### Shared-spine (Projects) fix that touches Books infra (`e38ba48`, migration 120)
- `get_org_id()` now falls back to the caller's **single active employee seat** when no org claim
  resolves (additive, fail-closed: 0/>1 seats → null; valid-claim sessions unchanged; no
  cross-tenant broadening). `entitlements.ts` resolves the caller's org **through** the RLS client
  so the gate, dashboard, and data queries share one resolution. Applied to live DB first.

### Autonomous run (`b0e869f`)
- Help-content reconcile to the S47 IA redesign (data-file only).

---

## 3. Data / infra changes (reproducibility notes)

**Migrations applied to Supabase (project `npqeijipggtuduhkejxq`), then code committed —
CONFIRMED PRESENT via live `list_migrations`:**

| File | Live version | Verified |
|---|---|---|
| `110_ai_gateway_execute_grants.sql` | `20260809131709` (S47) | ✅ |
| `111_location_is_management_company.sql` | `20260809133532` (S47) | ✅ |
| `112_documents_storage_bucket.sql` | `20260809142438` | ✅ (private `documents` bucket + storage RLS) |
| `113_bill_payments_bank_txn_unique.sql` | `20260809142830` | ✅ (UNIQUE `bill_payments(org_id, bank_transaction_id)`) |
| `120_get_org_id_single_active_employee_fallback.sql` | `20260809143540` | ✅ (Projects-authored, shared spine) |
| `121_practice_onboarding_ownership.sql` | `20260809153033` | ✅ (`core.practice_assignments` onboarding fn) |
| `130_customizable_rbac.sql` | `20260809153009` | ✅ (`core.custom_roles`, `core.role_permission_overrides`) |
| `131_org_billing_plan.sql` | `20260809161034` | ✅ (`core.organizations.billing_plan` + `custom_mrr_cents`) |
| `132_insurance_amortization.sql` | `20260809162941` | ✅ (`public.insurance_policies` amort) |
| `133_locations_functional_currency.sql` | `20260809162904` | ✅ (`core.locations.functional_currency`) |
| `135_org_inbound_ap_address.sql` | `20260809165506` | ✅ (`org.inbound_ap_address`) |

- **Note:** migration number **134 was skipped** (no `134_*` file — the Books/Projects band split
  leaves gaps by design). **Next Books migration number: 136.**
- **Two live Merit orgs (both named "Merit Management Group") — verified via live query:**
  - **`1d1aa1ef-4218-4187-a622-4a80da1a9e11`** — the **working seeded dev tenant** (3 locations),
    bound to the **DEV Clerk instance**. This is what production currently authenticates against.
  - **`eb3d8087-7798-480d-9617-bdf73f63918a`** — the **empty parked live tenant** (1 location),
    bound to **prod Clerk**. Production cutover is deferred (§4).
- **Vercel deploy:** auto-push loop → `next build` (authoritative typecheck). Migrations-first
  ordering was honored for all of the above.

---

## 4. Open items — DO NOT FORGET

### KNOWN-OPEN launch blockers (explicitly recorded so they aren't lost)

1. **Anthropic org is DISABLED / unfunded → ALL AI is operationally down.** This is an
   **account-level problem, NOT a code bug** — the `ANTHROPIC_API_KEY` account shows "This
   organization has been disabled." The app now **degrades gracefully** everywhere (calm
   "AI temporarily paused" payloads; deterministic paths and the FP&A heuristic parser still
   work). **Fix = fund/re-enable the Anthropic account** (Mike). Until then, every AI seam
   (document parse, categorize, draft-bill/invoice, NL) is paused even though the plumbing is
   correct.
2. **Production is intentionally on the DEV Clerk instance.** Do **NOT** re-cut to prod until
   **all of these are ready together**: (a) a **separate prod Supabase project**, (b) prod-Clerk
   **Third-Party-Auth trust** repointed, (c) a **funded Anthropic key**, and (d) a **live-billing
   decision**. The prior failed attempt was a **crossed publishable/secret key** — double-check
   `pk_`/`sk_` pairing on the next cutover. Parked live tenant `eb3d8087-…`.
3. **Live tenant billing/charging via Stripe is NOT wired.** The Operator Console MRR/ARR is
   **list-price computed only** (plan × active company count); there is no billing source in the
   schema and no charge button. Wiring real subscription charging is a deliberate future step
   (tied to blocker #2's live-billing decision).
4. **Stripe is in TEST mode and Plaid in SANDBOX.** No real money moves in the current
   environment.
5. **Payroll provider unpicked** (Check vs Gusto, task #34). The mock run engine is an
   **estimate only** ("no money moves," not a tax calc); the register-import→JE path is the honest
   primary. Gates Payroll Phase B (releaser≠preparer, double-post guard, live provider).
6. **Marketing-site honesty items** — reconcile claims to reality: **semantic search is
   Postgres FTS (GIN tsvector), NOT vector/embeddings**; **1099 IRIS/FIRE e-file is NOT built**
   as a real IRS submission; **insurance now DOES post** (migration 132 — that overclaim is
   FIXED). Audit remaining marketing copy against shipped capability.
7. **The paused hourly autonomous build task** remains paused — do not assume it is running.
8. **Standing pre-existing tsc / pglite test-harness failures are NOT regressions.** The known
   set (Stripe types when the SDK/env is unbuilt, `pglite` not installed so the migration-replay
   suites skip/error, `@meritbooks/core-ai` gateway-meta type when unbuilt, `tenant-isolation.test.ts`
   parse note) predates this session. Baseline noise, not new breakage.

### Company-scope guard exemptions (documented, intentional)
- A few master-data / cross-entity pages are **intentionally NOT `CompanyScopeGuard`-guarded**
  (consolidation, entities/portfolio roll-up, admin/settings, onboarding, Practice/Platform) —
  they operate above a single company and must remain reachable without an active company. Do not
  blanket-apply the guard.

### Carried-forward identity / RBAC residual (from S45–S47 — still open)
- Org resolution is **CLOSED live** (Clerk native `o.id` claim + auto-bind; S47 page-guard
  single-membership fallback + S48 `get_org_id` single-active-seat fallback are additive).
  **MANUAL for Mike:** stand up the **Clerk production instance for `app.meritbooks.app` + `org_id`
  claim** (retires the native-`o.id`/single-seat fallbacks), set **`EVENT_WORKER_SECRET`** +
  **`NEXT_PUBLIC_APP_URL`**, rotate the **Resend key** + set **`INVOICE_FROM_EMAIL`**.
  ⚠️ The marketing site is a SEPARATE Vercel project (`meritbooks-marketing`) — apex
  `meritbooks.app` stays with marketing; the app gets `app.` only. **Claude-side residual:**
  `core.assignments`, event-worker read/"peek" scoping, location-scoped RLS. (The per-route
  money-movement SoD keys are now DONE — see §2.)

### Other standing opens
- Master-Doc amendments awaiting Mike's ratification (task #19).
- Payroll provider pick — Check vs Gusto (task #34) — gates Payroll Phase B.
- Browser-verify the newest pages against the practice/billing/company-scope changes (task #18).

---

## 5. Direction — what's next

1. **Fund/re-enable the Anthropic account** to bring the whole AI surface back online, then
   re-verify a full drop-and-parse round-trip (upload → gateway → extraction) and the NL/FP&A
   paths against live AI.
2. **Make a live-billing decision**, then (if go) wire real Stripe subscription charging so the
   Operator Console MRR is realized, not list-price computed.
3. **Prepare (do not execute) the real production cutover** — dedicated prod Supabase project,
   prod-Clerk Third-Party-Auth trust, funded Anthropic key, scripted env swap with a pk/sk
   pairing check so the crossed-key failure cannot recur.
4. **Verify the practice operator flow in Chrome** on the deployed (dev-Clerk) app: new company →
   assign member + onboarding owner → per-company scoped processing → custom-role enforcement →
   Operator Console metrics → tenant billing page.
5. **Reconcile the marketing site to shipped reality** (FTS-not-vector, 1099 IRIS not built,
   insurance-posts fixed) and finish the identity Claude-side residual.
6. **Continue driving Invoices / Reports / Bank-Rec to *Complete*** behind their FPBs; pick the
   payroll provider to unblock Phase B.

---

## 6. Agents

Eight defined agents in `.claude/agents/` (builder, verifier, auditor, reviewer, designer,
scribe, security, chrome-auditor) + SDK agents (general-purpose, Explore, Plan). **All on
opus 4.8** (CLAUDE.md §0.1 binding). Parallel builder/general-purpose agents on file-disjoint
slices, 3–5 concurrent, one verification lane through the lead. Reserved shared spine
(migrations, `packages/shared`, `api-handler.ts`, `navigation.ts`, `rbac/permissions.ts`) is
single-threaded through the lead.

## 7. Live state

- **Repo HEAD:** `2c480e4` on `main`. Auto-push loop ships to Vercel; `next build` is the
  authoritative typecheck.
- **Auth:** production runs on the **DEV Clerk instance** (deliberate — see §4).
- **Supabase:** project `npqeijipggtuduhkejxq`; migrations through **135** applied (134 skipped);
  next Books number **136**.
- **Working tenant:** `1d1aa1ef-…` (seeded, 3 locations, dev Clerk). Parked live tenant:
  `eb3d8087-…` (1 location, prod Clerk).
- **AI:** Anthropic account **disabled/unfunded** — ALL AI seams operationally down; app degrades
  gracefully. Plumbing/grants are correct.
- **Money rails:** Stripe **TEST** mode, Plaid **SANDBOX**; live tenant billing NOT wired.
- **Known non-regression noise:** Stripe/pglite/nl-route/tenant-isolation type-harness failures
  (baseline).

## 8. One-line for the next session

Prod is still parked on dev-Clerk on purpose and the Anthropic org is dark (app now degrades
gracefully); this session made MeritBooks a real **multi-company practice product** — company-scoped
everything, add-company + per-company onboarding owners (mig 121), customizable permissions enforced
degrade-safe (mig 130), a per-company pricing/Operator-MRR model (mig 131, list-price only), and honest
modules (insurance now posts [132], consolidation FX [133], AP email-to-bill [135], payroll labeled
estimate) — next: **fund Anthropic, decide live billing, and prep a clean prod-Supabase + prod-Clerk cutover.**
