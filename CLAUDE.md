# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## §0. SESSION-START & RE-GROUND PROTOCOL (READ FIRST — non-negotiable)

The canon lives in `docs/canon/`. It was mirrored there because a session once built downstream,
ungated, spec-less work off a stale copy of this file. Do not repeat that.

**Re-ground at every one of these triggers — not just at session start:**

1. **Cold session start.**
2. **Immediately after any context compaction** — the tell is that the turn opens with a
   "summary of the conversation so far" block instead of real history. STOP and re-ground before building.
3. **Before starting any new module / gate / build wave** (the Phase-0 reconcile).
4. **On any contradiction** between what you remember and what the repo/docs say.
5. **Periodically on long sessions**, even absent a formal compaction.

**What re-grounding means (cheap → deep):**

- Always read `docs/canon/CANON-ANCHOR.md` in full (small, ~5 min). It holds the hard invariants,
  the current GATE state, and the immediate priorities.
- Read the newest `docs/MERITBOOKS-HANDOFF-session[N].md` (highest N).
- For the area you're about to build, read the relevant digest in `docs/canon/` (index: `00-INDEX.md`),
  and the exact source doc in Project knowledge for precise wording.
- **Reconcile before building** (Future-Session-Instructions Phase 0): the Master Doc register is
  authoritative only after you've checked it against the live repo/DB.

**Governing-doc hierarchy (highest wins on conflict):** the Project-knowledge **Master Document**
(`MeritBooks-Master-Document`, highest version) → the suite contracts (architecture, ownership matrix,
FROZEN v3 event contract, identity model) → the Transaction Posting Engine Spec (GATE 2) → the Build
Spec v4.3 → the newest handoff → this `CLAUDE.md`. Where this file disagrees with the canon, **the
canon wins** — fix this file.

## §0.1 AGENT & BUILD OPERATING RULES

**The eight defined agents (`.claude/agents/`) and when each MUST run:**

| Agent | Model | Role | Mandatory when |
|---|---|---|---|
| **builder** | sonnet | Implements a well-specified change (migration/route/resolver/UI) on a branch, with passing tests. Won't invent product/pricing/data-model decisions — stops and reports ambiguity. | Every implementation slice. |
| **designer** | opus | Owns the design system; makes UI look authored, not generated. | Any new/elevated user-facing screen. |
| **verifier** | sonnet | Read-only. Runs tests, typecheck, inspects live Supabase/Vercel to report TRUTH vs claims. | After EVERY build/deploy, before trusting any "done." |
| **chrome-auditor** | sonnet | Drives the deployed app in Chrome; confirms render + org-scoping + reversible writes; reads console/network. | After any user-facing deploy (never hand Mike a click-through). |
| **security** | opus | Audits RLS/tenant isolation/authz/secrets/PII on a fintech book of record. | Any change to auth, data access, money movement, public routes, or before a new tenant. |
| **reviewer** | opus | Code-craft/maintainability review (right-sized files, layering, no god-files). | After a build, before merge of non-trivial code. |
| **auditor** | opus | Rule-16 depth audit vs the FPB; scores the Completeness Ledger; **writes FPBs**. | Before calling a module "Complete"; to author a module's FPB. |
| **scribe** | sonnet | Writes the handoff + updates Master Doc banner/Ledger from git + live schema (never from memory). | Session end / when docs drift. |

Plus SDK agents: **general-purpose** (parallel builders on disjoint slices — the wave workhorse),
**Explore** (read-only fan-out search), **Plan** (implementation planning).

**OWNER DIRECTIVE (2026-08-01): run EVERY agent on `opus` (claude-opus-4-8).** Pass
`model: "opus"` on every Agent/subagent launch, overriding the sonnet defaults in the frontmatter
of builder / verifier / chrome-auditor / scribe. No agent runs on sonnet or haiku.

**How many run at once:** launch builder/general-purpose agents on **file-disjoint** slices,
**3–5 concurrently** (comfortable ceiling given one verification lane + a memory-limited sandbox);
issue them in ONE message so they run in parallel. Use `isolation: "worktree"` for any that must
touch overlapping files. **The verification lane is a single thread (the lead) — that, plus
migration serialization and FPB authorship, is the real throughput ceiling, not agent count.**

**Reserved shared spine (single-threaded through the lead — agents REPORT needs, never edit these):**
`packages/supabase/migrations/*` (sequentially numbered; apply to Supabase first), `packages/shared/*`,
`apps/web/src/lib/api-handler.ts`, `apps/web/src/lib/navigation.ts`, `apps/web/src/lib/rbac/permissions.ts`.
Agents that need a new table/column/nav entry/permission stop and report it; they never invent schema.

**Mandatory wave pipeline:** re-ground (§0) → confirm/author the module **FPB** (auditor, Rule 13) →
carve disjoint slices → parallel **builder/general-purpose** wave (+ **designer** on UI) → **verifier**
+ **chrome-auditor** (+ **security** for money/identity/public routes) → **reviewer** → lead integrates
→ **scribe** updates handoff + Ledger.

**Auto-deploy loop:** commit to `main` locally → an auto-push loop on Mike's machine
(`while true; do git -C ~/Projects/meritbooks push origin main; sleep 30; done`) ships it → Vercel runs
`next build` (the **authoritative full-project typecheck — fails closed**, so a type error blocks the
deploy, never prod) → the lead pulls the Vercel deployment result (READY = build/typecheck green) and
fixes anything it flags. **Migrations go to Supabase FIRST, then the code that depends on them is committed.**
Claude cannot push from the sandbox and must not handle a push token — the loop is the sanctioned mechanism.

## What This Is

MeritBooks is a generic, AI-native, multi-tenant SaaS **book of record** — it OWNS the general
ledger (it is NOT an automation layer on top of QuickBooks/Sage; those are one-time migration import
sources). It is **Module 1 of 12** in the Merit Enterprise Suite (white-label, resellable). Merit
Management Group is simply its first tenant — nothing Merit-specific is hardcoded. It handles GL
posting, bank-feed categorization, financial reports, bills/invoices/AR, revenue recognition,
inter-department internal invoicing with consolidation eliminations, vendor compliance, and money
movement (Plaid/Stripe). NOTE: the old "workforce chargebacks / overhead burden-rate / 5 labor
classifications / in-app time tracking" engine was **RETIRED in Session 12 — do not rebuild it**
(see `docs/canon/CANON-ANCHOR.md` §2). Time tracking lives in the separate PM module. The three
pillars are: the GL (book of record), AI automation that eliminates manual data entry, and native FP&A.

## Commands

```bash
npm run dev              # Start dev server (Next.js + Turbopack)
npm run build            # Build all apps and packages
npm run lint             # ESLint across workspaces
npm run type-check       # TypeScript type checking across workspaces

npm run db:migrate       # Push Supabase migrations
npm run db:seed          # Seed database with demo data (17 companies, 251 accounts)
npm run db:reset         # Reset database
npm run db:types         # Generate TypeScript types from Supabase schema
```

**Testing: Vitest.** Run with `npm test --workspace apps/web` (or `npm run test:watch --workspace apps/web`). Config at `apps/web/vitest.config.ts`. ~124 test cases across 10 files (one integration file skips until a Supabase test branch is wired).

Tests run against a real Postgres via a PGlite migration-replay harness (`apps/web/src/test/pg.ts`) — it replays `packages/supabase/migrations/*.sql` in order into an in-memory Postgres, so a test failure can mean a broken migration, not just broken code. Guard tests that fail the build on drift:
- `src/test/schema.test.ts` — asserts every `entry_type` the code posts exists in the enum, and that every base table in `public`/`core` has RLS enabled.
- `src/test/schema-contract.test.ts` — every constrained literal the code writes must be accepted by its CHECK/enum.
- `src/test/tenant-isolation.test.ts` — RLS actually isolates orgs.
- `src/test/payment-chain.integration.test.ts` — end-to-end payment → PAID → balanced GL post (skips until a test branch is wired).
Plus unit suites: GL posting balance, fee arithmetic (`lib/money/fees.test.ts`), money-movement posting, RBAC `permissionDenied`, middleware, invoice email.

## Architecture

**Monorepo** (Turborepo + npm workspaces):
- `apps/web/` — Next.js 14 App Router application
- `packages/shared/` — Shared types (auto-generated from Supabase) and utilities
- `packages/supabase/` — Database migrations (9 SQL files) and seed scripts

**Stack**: Next.js 14, React 18, TypeScript, Tailwind CSS, Supabase (PostgreSQL 16), Clerk (auth), Plaid (banking), Claude API (AI categorization), Zod (validation)

### Key Architectural Patterns

**All money is stored as cents (bigint).** Use `formatMoney()`, `dollarsToCents()`, `centsToDollars()` from `packages/shared/src/utils/money.ts`. Never use floating-point for monetary arithmetic.

**Double-entry is enforced at the database level.** A `check_journal_balance()` trigger rejects any journal entry where debits ≠ credits. Six enforcement triggers total cover balance checks, period locks, control accounts, approved accounts, dimension validation, and entry number generation.

**Multi-tenant isolation via Row-Level Security.** Every table uses RLS policies keyed to `org_id` from Clerk JWT claims. Two Supabase clients exist:
- `createServerSupabase()` — respects RLS (default, use this)
- `createAdminSupabase()` — bypasses RLS (use only when intentional)

**API routes use `apiHandler()` / `apiQueryHandler()` wrapper** (`apps/web/src/lib/api-handler.ts`). This enforces Clerk auth, Zod validation, and error handling. Every API route must use this wrapper — don't write raw route handlers.

**Server components by default.** Only use `'use client'` where interactivity is required.

**Fiscal period enforcement.** Periods track OPEN / SOFT_CLOSE / HARD_CLOSE status per location per month. The database prevents posting to closed periods.

### Code Organization (apps/web/src/)

- `app/(app)/` — Authenticated routes (21 pages: dashboard, journal-entries, bank-feed, reports, etc.)
- `app/api/` — API routes (gl/post, gl/trial-balance, bank-feed/approve, bills/create, chargebacks/generate, overhead-rate, receipts/submit)
- `lib/services/` — Business logic (gl-posting, categorization, chargeback, overhead-rate)
- `lib/validations/` — Zod schemas for API input validation
- `lib/supabase/` — Server/client Supabase setup
- `lib/api-client.ts` — Typed fetch wrapper returning `{ data, error, status }`
- `components/` — React components (UI + layout)
- `hooks/` — Custom React hooks

### Adding a New API Route

1. Define Zod schema in `lib/validations/`
2. Create route file in `app/api/<resource>/<action>/route.ts`
3. Export handler wrapped with `apiHandler(schema, async (body, ctx) => { ... })`
4. The `ctx` provides `userId`, `orgId`, and an RLS-scoped `supabase` client

### Database

9 ordered migrations in `packages/supabase/migrations/` covering: foundation tables, dimensions (location/department/class/item), chart of accounts (251 accounts, 7 types, 11 sub-types, 71 groups), general ledger, transactions, workforce chargebacks, close/audit/compliance, sub-ledgers (AP/AR), and reporting views.

Seed data includes the full Merit Management Group org with 17 portfolio companies, 10 departments, and 12 months of 2026 fiscal periods.

## Environment Variables

```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY    # Clerk auth (public)
CLERK_SECRET_KEY                      # Clerk auth (secret)
NEXT_PUBLIC_SUPABASE_URL             # Supabase URL (public)
NEXT_PUBLIC_SUPABASE_ANON_KEY        # Supabase anon key (public)
SUPABASE_SERVICE_ROLE_KEY            # Supabase admin (secret)
ANTHROPIC_API_KEY                    # Claude API (server-side only)
PLAID_CLIENT_ID                      # Plaid banking (server-side only)
PLAID_SECRET                         # Plaid banking (server-side only)
```

## Current Build State

The authoritative, always-current build state lives in the latest session handoff. **Start every session by reading the newest `docs/MERITBOOKS-HANDOFF-session[N].md`** (highest N). Handoffs follow the Rule-11 8-section format and are the ground-truth record of what works, what's broken, and what to build next.

Latest handoff: **`docs/MERITBOOKS-HANDOFF-session40.md`** (2026-08-01).

Snapshot as of session 40 (see the handoff for detail):
- Live at `meritbooks-web.vercel.app`, production `main` @ `95b52b2`, Vercel state READY (so `next build` — the authoritative full-project typecheck — is green).
- **Money-approval layer unblocked**: `canApprove()` now reads `core.employees.role` + `ROLE_DEFINITIONS` (it used to fail closed against an unbuilt `core.roles` table), so check/bill/payroll approval works for `company_admin`. Separation of duties unchanged.
- **Three autonomous pipelines shipped via a parallel-agent wave**: Vendor Compliance risk engine (COI/W9 → tier → escalate to `/exceptions`), Reconciliation autopilot (composite matcher → tiered accept/reject), 13-Week Cash Forecast (real projection off bank + AR/AP by due date). Plus a `/api/cash` RLS-leak fix and a statement-reconciliation `NOT NULL` crash fix.
- **Stripe "Pay Now"** end-to-end (balanced `AR_COLLECTION`), invoices/customers/hosted pay page/email; **two-layer fee model** live (`core.merchant_fee_schedules` + `lib/money/fees.ts`).
- **Security mid-hardening**: RLS enforced across the authed API (org_isolation, Clerk token → `org_id`), auth fails closed, `require-permission` guard on `gl/post` as the reference pattern. Full RBAC rollout + identity reconciliation is the open NO-GO gate (task #9) — see the handoff backlog.
- Eight subagents in `.claude/agents/` (builder, verifier, auditor, reviewer, designer, scribe, security, chrome-auditor). Parallel `general-purpose` builders on disjoint slices are the current execution model.
- **Delivery workflow: committed directly to this repo; an auto-push loop on Mike's machine ships commits automatically** (no manual push gate). Migrations applied to Supabase first, then code committed.
- **Immediate next step:** browser-verify `/vendor-compliance`, `/reconciliation` (autopilot tab), and `/forecast` with real data, then the **AP inbox pipeline** as the next parallel wave.

Do NOT trust older "Session 7 / Bank Feed only" or "session 38" snapshots — long superseded.

## Design System (BINDING)

Primary accent: #10b981 (Tailwind emerald-500). Dark dominant, surface-900 for cards, surface-950 for nested. Typography: Plus Jakarta Sans (UI), JetBrains Mono (numbers/codes). Text: white primary, slate-300 secondary, slate-500 tertiary. Emerald for debits/success, red for credits/danger, amber warning, blue info, indigo AI features.

## Business Rules

Overhead Rate / burden / 5-labor-classifications / chargebacks: **RETIRED in Session 12 — do NOT rebuild** (superseded by inter-department internal invoices with consolidation eliminations; see `docs/canon/CANON-ANCHOR.md` §2). The formula is retained here only as historical context, not as something to build: (retired) Shared OpEx Pool = Total 6000-series OpEx − 10% Owner Group − 100% Deal Team − 100% Direct Assigned; OH Rate = Pool / (Production Employees × 150 hrs/mo).

Bank Feed Matching: Composite Score = Vendor 40% + Amount 40% + Date 20%. >=90% auto-categorize, 70-89% review, <70% flagged. Auto-approve: confidence >=85% AND trusted vendor AND amount <= $10,000.

Money: All monetary values stored as bigint cents. Use formatMoney(), dollarsToCents(), centsToDollars() from packages/shared/src/utils/money.ts. NEVER use floating point for money.

## Mandatory Build Rules

Rule 1 - Understand Before Building: Before writing code, state the goal, user persona, data dependencies, and prior decisions. Read the relevant migration SQL to verify column names.

Rule 2 - Proactive Enhancement: Before building, identify 2-3 things the best products do that have not been asked for. Build at least 1-2 of them.

Rule 3 - Completion Means Completion: Do not say done or built unless ALL of these are true: renders in all states (loading/empty/populated/error), interactive elements function, data flows from real Supabase queries, errors handled, matches design system, accessible. If partial, say exactly what works and what does not.

Rule 4 - No Skeletons: A page with hardcoded demo arrays is a MOCKUP not a feature. Never build 10 skeletons instead of 1 working page. Depth over breadth.

Rule 5 - Modern Practices: TypeScript with proper interfaces (no any). Loading/error/empty states. Debounced search. Paginated lists. Confirmation for destructive actions. Responsive. Keyboard accessible.

Rule 6 - Full Context: Never silently drop a requirement discussed earlier. Review all prior context before building.

Rule 7 - Independent Judgment: You are a senior engineer and CPA. Add period selectors, sorting, validation, and drill-down without being asked.

Rule 8 - Communicate Status: Start with what you are building and why. End with what is complete, what is partial, what is next.

Rule 9 - Overbuild: Easier to remove a feature than to remember to add one later.

Rule 10 - Never Repeat These Failures: Never claim built when rendering demo data (say mockup). Never breadth over depth. Never build page components before verifying schema column names. Never use any type or plain JavaScript. Never forms without validation or reports without period selection. Never omit loading/error/empty states. Never standalone artifacts instead of codebase-integrated files. Never build UI when the priority is infrastructure.

Rule 11 - Schema Ground Truth: ALWAYS cat the relevant migration SQL in packages/supabase/migrations/ before writing any query. If a column name does not match the migration file, your code is wrong.

Rule 12 - Self-Audit Every Response: After writing code, check Rules 3, 4, 5, and 10 against your output. If any rule fails, fix it before presenting. Do not wait to be asked.

## Feature Audit Checklist (MANDATORY)

Before building or modifying any page, do the following:
1. Open docs/meritbooks-exhaustive-feature-audit.md
2. Find every audit item number for that page
3. List them in your plan
4. After building, verify each one is covered
5. If an item is intentionally deferred, say so and why

The audit file is the cross-reference checklist for every feature in the product. If you build a page without checking the audit, you are violating Rule 6 (Full Context).

## Bank Feed — Required Features (from Build Spec §09 + Prior Sessions)

These are not suggestions. All must be present in the Bank Feed page:

Core (Spec §09, Audit #160-163):
- AI-categorized transactions sorted by confidence (lowest first = needs most attention)
- Confidence bars showing AI certainty percentage
- Match status badges (matched to bill, matched to receipt, unmatched)
- 3 actions per transaction: Approve, Flag, Edit
- Batch approve for high-confidence items

Enhancements (validated in prior sessions, carry forward):
- Processing metrics strip: Processed today X/Y (Z%), AI auto-approved count, Avg confidence
- Smart batch selection: "Select all >=90% confidence" button
- Vendor batch selection: click vendor name to select all transactions from that vendor
- Sortable column headers (date, amount, confidence, vendor, company)
- Inline GL account search with vendor recents (top 5 most-used accounts for this vendor) in the edit panel
- Edit slide-out panel with: vendor name, GL account search, AI reasoning display, notes field, Save & Approve

Already built (keep these):
- Keyboard shortcuts (j/k/a/f/Space/Esc)
- Dollar amounts in status tabs
- Toast notifications on approve/error
- Loading/error/empty states
- Debounced search
- Real Supabase queries

## Dev Server Management

Before starting a dev server with npm run dev, always kill any existing dev servers first:
lsof -ti:3000,3001,3002 | xargs kill -9 2>/dev/null
Always use port 3000. Never leave orphaned servers running on other ports.
