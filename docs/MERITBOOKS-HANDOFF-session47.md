# MeritBooks — Session 47 Handoff

**Date:** 2026-08-09
**Supersedes:** session 46. Use this as the current source of truth for build state.
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
> commits except where they touch the shared spine.

---

## 1. Headline

The **operability + white-label + auth-stability** session. Where Session 46 opened the last
AI modalities to depth, Session 47 made the product **usable end-to-end for a real operator**
and **safe to run on the live URL** — and it did so by first **reverting a broken production
auth cutover** rather than pushing forward on a foundation that was silently failing.

The arc, in order:

1. **Production Clerk cutover was REVERTED to the dev instance.** The attempted prod cutover
   was failing because the **publishable and secret keys were crossed** (the classic
   `pk_live`/`sk_live` transposition). Rather than chase it live, the session **reverted the
   Vercel Clerk env to the working DEV instance** and forced a clean rebuild
   (`f697bc1`) to inline the dev publishable key. **Production now runs on the DEV Clerk
   instance on purpose** (see §4 — this is a deliberate parked state, not a bug).
2. **RBAC page-guard org-resolution fix.** ~18 pages were bouncing users back to the dashboard
   because the page-level guard couldn't resolve the tenant. Added a **single-active-membership
   org fallback** (`2de05d5`) so a user with exactly one active membership resolves cleanly.
3. **Five erroring pages fixed** (`0f33cde`) — tax depreciation, sales tax, book-to-tax,
   consolidation, fixed assets — all broken by a mix of **unwrapped API envelopes**, a
   **cross-schema (`public`→`core`) PostgREST embed** (canon §2 forbids it — stitch in JS),
   and a **consolidation query-param bug**.
4. **Full sidebar INFORMATION-ARCHITECTURE redesign** (`fc73874`, `ddbe504`) — `navigation.ts`
   collapsed into **9 workflow groups**, many standalone pages folded into tabs/redirects, and
   `planes.ts` remapped to the new group labels (the sidebar was rendering empty until the
   plane→group mapping was fixed).
5. **Company-scoped processing control** (`bdf5b6b`, `33c6c59`) — the biggest behavioral change.
   An **active-company cookie context** now scopes the processing surface: a header company
   picker, `useQuery` auto-scoping `location_id`, a **`CompanyScopeGuard` on 31 processing
   route files**, the sidebar **hiding processing nav until a company is selected**, a
   consolidated dashboard when none is, and **reports consolidation gated to admins**.
6. **Migrations 110 + 111** (both applied to Supabase first) — `110` fixes document upload
   (grants EXECUTE on the Core AI-gateway RPCs to `authenticated`); `111` replaces the
   hardcoded `'merit management'` name-match with a real `core.locations.is_management_company`
   flag (white-label fix).
7. **Per-page help system**, **FP&A natural-language scenarios**, **real global search palette +
   notifications bell** in the header, and a **white-label copy scrub** (Portfolio → Entities).

Everything below is on `main`. **HEAD is `f961727`.** The auto-push loop ships commits to
Vercel, whose `next build` is the authoritative full-project typecheck. Migrations 110–111
were applied to Supabase **first**, then the dependent code committed (canon migration rule).

> **Note on the intervening wave.** Session 46's HEAD was `f056033` (migrations 095–098).
> Between that handoff and this one, the "Session-47 in-flight wave" it named **landed in full**
> plus more — **migrations 099–109**: bank-rec Wave B (`099`/`100`), inventory MVP + depth
> (`101`), practice assignments (`102`), sales-tax at-invoice (`103`–`105`), report packs
> (`104`), onboarding wizard + entity setup (`106`/`107`), and the **ERP connector framework**
> (`108`/`109`, delegated-admin MANAGEMENT vs PREPARER scope). Those are considered shipped and
> live; this handoff's depth is on items 1–7 above (the newest, previously-undocumented arc).

---

## 2. What shipped this session (Books)

### Auth: revert the prod cutover, stabilize on dev Clerk

- `f697bc1` **revert + clean rebuild** — Vercel Clerk env repointed to the DEV instance;
  Supabase Third-Party Auth repointed to the dev Clerk domain; redeploy verified dev auth works.
  Root cause of the failed prod attempt: **crossed publishable/secret keys.** Production is now
  **intentionally on dev Clerk** until a dedicated prod Supabase project + prod Clerk are stood
  up together (§4). (Tasks #141–143.)

### RBAC page-guard org resolution (`2de05d5`)

- Page-level guard now falls back to the user's **single active membership** when the org claim
  is unresolved, fixing ~18 pages that reverted to the dashboard. This is a **page-guard-only**
  convenience fallback; the server-side `get_org_id()` claim-first resolution from Session 45
  (Clerk native `o.id`) is unchanged. (Task #144.)

### Five erroring pages fixed (`0f33cde`)

- **tax-depreciation / sales-tax / book-to-tax** — unwrapped API-envelope reads.
- **fixed-assets** — stopped a `public`→`core` cross-schema embed (stitch in JS per canon §2).
- **consolidation** — query-param bug. (Task #145.)

### Sidebar information architecture redesign (`fc73874`, `ddbe504`)

- `navigation.ts` reorganized into **9 top-level workflow groups**: **Home · Payables ·
  Receivables · Banking & Cash · Accounting · Reporting & Analytics · Firm & Governance ·
  Settings & Admin · Platform.** Many standalone pages folded into tabs or redirects; two legacy
  dup routes (`/recurring`, `/invoices/collections`) already flagged in S45 remain redirect
  targets. `planes.ts` remapped to the new group labels — the sidebar rendered **empty** until
  `ddbe504` fixed the plane→group mapping. (Task #146.)

### Company-scoped processing control (`bdf5b6b`, `33c6c59`)

- **Active-company context** — `lib/hooks/use-active-company.tsx` (+ `lib/company-scope.ts`)
  holds the selected entity in a cookie; a **header company picker** sets it.
- **`useQuery` auto-scopes `location_id`** to the active company so every processing list is
  entity-filtered without per-page plumbing.
- **`CompanyScopeGuard`** mounted on **31 processing route files** — the guard blocks a
  processing page until a company is selected and routes the user to pick one.
- **Sidebar hides the processing nav** until a company is chosen; **dashboard shows a
  consolidated summary** (all entities) when none is selected and an enter-company affordance.
- **Reports consolidation gated to admins.**
- **A few master-data / cross-entity pages are intentionally NOT guarded** (documented) — they
  operate above a single company (see §4). (Tasks #148, #152, #153.)

### Migration 110 — AI-gateway EXECUTE grants (document-upload fix)

- Applied to Supabase (version `20260809131709`, `110_ai_gateway_execute_grants.sql`).
  Every drop-and-parse route runs its file through the Core AI gateway, whose first runaway
  guard calls `core.ai_bump_rate(...)` (+ concurrency/counter RPCs). Those routes build the
  gateway client from the **RLS-scoped `authenticated`** client, but the live DB only granted
  EXECUTE to `service_role` — so uploads failed with `permission denied for function
  ai_bump_rate`. Migration 110 (re)grants EXECUTE to `authenticated` (functions are already
  SECURITY DEFINER with pinned `search_path`). Idempotent. Also restored drag-and-drop upload.
  (Task #147.)

### Migration 111 — `core.locations.is_management_company` (white-label)

- Applied to Supabase (version `20260809133532`, `111_location_is_management_company.sql`).
  Adds a real tenant-owned boolean flag (default false) for the parent/management/holding entity
  — the one consolidated INTO and excluded from the "portfolio companies & third parties"
  working scope. **`api/me` now filters on `!is_management_company`** instead of a hardcoded
  `name ilike '%merit management%'` heuristic (`33c6c59`). One-time additive backfill flips
  `false→true` only for the legacy Merit match; idempotent. Core band; next number: **112**.

### Per-page help system

- Route-keyed help registry (`lib/help/help-content.ts`, ~1020 lines) + a `HelpButton`
  slide-over (`components/help/help-button.tsx`) rendered from the page header — each route gets
  a plain-language explanation. (Task #150.)

### FP&A natural-language scenarios

- `POST /api/fpna/nl-scenario` (`app/api/fpna/nl-scenario/route.ts`, ~422 lines) routes a
  described what-if through the **Core AI gateway** (never a direct Anthropic call, canon §2)
  and returns a structured scenario for the FP&A dashboard. (Task #151.)

### Real global search + notifications in the header

- **Search palette** (`components/layout/search-palette.tsx`) backed by the existing
  `/api/search` (GIN tsvector, S46) and a **notifications bell**
  (`components/layout/notifications-bell.tsx`) backed by `/api/inbox` — replacing the prior
  placeholder header affordances.

### White-label copy scrub

- Portfolio → **Entities** across the UI; the retired Merit-specific "portfolio company" framing
  removed and replaced with generic tenant language (pairs with migration 111). (Task #149.)

---

## 3. Data / infra changes (reproducibility notes)

- **Migrations applied to Supabase (project `npqeijipggtuduhkejxq`), then code committed:**
  - `110_ai_gateway_execute_grants.sql` — recorded as `20260809131709`. Verified live:
    grants present; document upload works.
  - `111_location_is_management_company.sql` — recorded as `20260809133532`. Verified live:
    `core.locations.is_management_company` column exists.
  - Next Books migration number: **112**.
- **Two live Merit orgs (verified via live query):**
  - **`1d1aa1ef-4218-4187-a622-4a80da1a9e11`** — the **working seeded dev tenant** (3 locations),
    bound to the **DEV Clerk instance**. This is what production currently authenticates against.
  - **`eb3d8087-7798-480d-9617-bdf73f63918a`** — the **empty parked live tenant** (1 location),
    bound to **prod Clerk**. Production cutover is deferred until a dedicated prod Supabase
    project + build-out are ready (§4).
  - (Note: the `is_management_company` backfill flipped no rows on either org — the seeded
    Merit location name doesn't match the legacy `'merit management'` heuristic. Set the flag
    explicitly on the intended parent entity when needed; the app now reads the flag, not a name.)
- **Vercel deploy:** auto-push loop → `next build` (authoritative typecheck). Migrations-first
  ordering was honored for 110/111.

---

## 4. Open items — DO NOT FORGET

### KNOWN-OPEN (explicitly recorded so they aren't lost)

1. **Document AI parse fails with Anthropic "This organization has been disabled."**
   This is an **account-level problem, NOT a code bug** — the `ANTHROPIC_API_KEY` account is
   **disabled (billing/credits)**. Migration 110 fixed the *Postgres permission* half of upload;
   the remaining failure is the AI account. **Fix = fund/re-enable the Anthropic account** (Mike).
   Until then, drop-and-parse AI extraction will error even though the plumbing is correct.
2. **Production is intentionally on the DEV Clerk instance right now.**
   Do **NOT** re-cut to prod until **all three** are ready together: (a) a **separate prod
   Supabase project**, (b) **Supabase Third-Party-Auth trust** repointed to the prod Clerk
   domain, and (c) a **funded Anthropic key**. The failed prior attempt was a **crossed
   publishable/secret key** — double-check `pk_`/`sk_` pairing on the next cutover. The parked
   live tenant is `eb3d8087-…`.
3. **Company-scope: a few master-data / cross-entity pages are intentionally NOT guarded**
   (documented). These operate above a single entity (e.g. consolidation, entities/portfolio
   roll-up, admin/settings, onboarding) and must remain reachable without an active company
   selected. Do not blanket-apply `CompanyScopeGuard` to them.
4. **Standing pre-existing tsc/test-harness failures are NOT regressions.**
   The known set (Stripe types when the SDK/env is unbuilt, `pglite` not installed so the
   migration-replay suites skip/error, the `nl`/route gateway-meta type when `@meritbooks/core-ai`
   is unbuilt, `tenant-isolation.test.ts` parse note) predates this session. Treat them as
   baseline noise, not new breakage.

### Carried-forward identity / RBAC residual (from S45/S46 — still open)

- Org resolution is **CLOSED live** (Clerk native `o.id` claim + auto-bind); the S47 page-guard
  fallback is additive. **MANUAL for Mike:** stand up the **Clerk production instance for the app
  domain + `org_id` claim** (retires the native-`o.id`/single-membership fallbacks), set
  **`EVENT_WORKER_SECRET`** + **`NEXT_PUBLIC_APP_URL`**, rotate the **Resend key** + set
  **`INVOICE_FROM_EMAIL`**. **Claude-side:** split `payments` into per-route keys (task #56),
  control-route + `team_performance` permissions, `core.assignments`, event-worker read-scoping,
  location-scoped RLS (tasks #33/#131).

### Other standing opens

- Master-Doc amendments awaiting Mike's ratification (task #19).
- Payroll provider pick — Check vs Gusto (task #34) — gates Payroll Phase B.
- Browser-verify the newest pages against the company-scope + IA changes (task #18).
- Drop-and-parse follow-ups: doc storage bucket + small schema (task #71).

---

## 5. Direction — what's next

1. **Verify the operator experience end-to-end in Chrome** on the deployed (dev-Clerk) app:
   company picker → scoped processing pages → guard behavior → consolidated dashboard →
   reports admin-gate. Confirm no page reverts to dashboard post page-guard fix.
2. **Unblock document AI** by funding/re-enabling the Anthropic account, then re-verify a full
   drop-and-parse round-trip (upload → gateway → extraction).
3. **Prepare (do not execute) the real production cutover** — provision a dedicated prod Supabase
   project, repoint prod Clerk Third-Party-Auth trust, and script the env swap with a
   pk/sk pairing check so the crossed-key failure cannot recur.
4. **Continue driving Invoices / Reports / Bank-Rec to *Complete*** behind their FPBs, and finish
   the identity per-route SoD residual.
5. Sweep the newly IA-reorganized + company-scoped pages for polish (loading/empty/error states
   under the new active-company context).

---

## 6. Agents

Eight defined agents in `.claude/agents/` (builder, verifier, auditor, reviewer, designer,
scribe, security, chrome-auditor) + SDK agents (general-purpose, Explore, Plan). **All on
opus 4.8** (CLAUDE.md §0.1 binding). Parallel builder/general-purpose agents on file-disjoint
slices, 3–5 concurrent, one verification lane through the lead. Reserved shared spine
(migrations, `packages/shared`, `api-handler.ts`, `navigation.ts`, `rbac/permissions.ts`) is
single-threaded through the lead.

## 7. Live state

- **Repo HEAD:** `f961727` on `main`. Auto-push loop ships to Vercel; `next build` is the
  authoritative typecheck.
- **Auth:** production runs on the **DEV Clerk instance** (deliberate — see §4).
- **Supabase:** project `npqeijipggtuduhkejxq`; migrations through **111** applied; next **112**.
- **Working tenant:** `1d1aa1ef-…` (seeded, dev Clerk). Parked live tenant: `eb3d8087-…`.
- **Known non-regression noise:** Stripe/pglite/nl-route type-harness failures (baseline).
- **AI:** Anthropic account currently **disabled** — document parse blocked at the account level
  until funded (plumbing/grants are correct).

## 8. One-line for the next session

Prod is parked on dev-Clerk on purpose (crossed pk/sk sank the cutover); the app is now
company-scoped with a 9-group IA and working upload grants (mig 110) + a white-label
management-company flag (mig 111) — next: verify the operator flow in Chrome, fund the
Anthropic account to unblock document AI, and prep a clean prod-Supabase + prod-Clerk cutover.

---

## Autonomous run log

- **2026-08-09 (autonomous):** Help-content reconcile to the S47 IA redesign. Added the missing
  `/compliance` (merged Compliance & Controls shell) help entry, and enriched `/bank-feed`
  (Credit Cards + Apply Deposits tabs) and `/tax/sales-tax` (Filing Calendar + Return Worksheet
  tabs) so the merged parent pages describe the functionality folded into them. Data-file only
  (`lib/help/help-content.ts`), no runtime logic. Typecheck clean on the touched file.
