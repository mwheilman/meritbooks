# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

MeritBooks is an AI-native accounting platform for Merit Management Group's 17 portfolio companies. It handles GL posting, bank feed categorization, financial reports, bills/invoices, workforce chargebacks, and compliance tracking. This is Module 1 of 12 in the Merit Enterprise Suite.

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

No test framework is currently installed.

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

## Current Build State (Updated Session 7 — April 5, 2026)

Bank Feed is the first page wired to real Supabase data. All other 33 pages still render hardcoded demo arrays.

WHAT WORKS:
- Bank Feed page queries real bank_transactions table via GET /api/bank-feed
- 25 seed transactions exist for Swan Creek Construction
- Status tab filters with dollar amounts
- Debounced search, pagination, loading/error/empty states
- Approve button calls POST /api/bank-feed/approve and creates real journal entries
- Toast notifications on approve/error
- Keyboard shortcuts (j/k/a/f/Space/Esc)
- Company selector dropdown (queries /api/locations)
- Edit panel with GL account search, vendor recents, notes, Save & Approve
- Job selector in edit panel (queries /api/jobs/search) — COGS accounts require job assignment
- apps/web/.env.local exists with Supabase + Clerk credentials (do not commit to git)
- docs/meritbooks-exhaustive-feature-audit.md is in the repo

WHAT IS BROKEN OR INCOMPLETE:
- Migration 010 (job_id columns on bank_transactions) has NOT been applied to Supabase — must run in SQL Editor
- The bank-feed API had 500 errors from joining final_job before migration was applied — join was removed as workaround
- Flag button shows not yet implemented toast
- Edit button wiring needs verification
- Processing metrics strip exists as component but may not render
- Smart batch selection needs verification
- Vendor batch selection needs verification
- Sortable column headers need verification
- 19 pre-existing TypeScript errors across other files (not bank-feed related)

WHAT IS NOT BUILT:
- All other 33 pages still render demo data
- No Financial Reporting Engine
- No Accounts Receivable
- No Job Costing pages
- No Onboarding Wizard
- No Plaid or M365 integration
- No RBAC enforcement

NEXT SESSION PRIORITY: Verify bank feed features actually render in browser. Fix anything broken. Then wire the next page.

## Design System (BINDING)

Primary accent: #10b981 (Tailwind emerald-500). Dark dominant, surface-900 for cards, surface-950 for nested. Typography: Plus Jakarta Sans (UI), JetBrains Mono (numbers/codes). Text: white primary, slate-300 secondary, slate-500 tertiary. Emerald for debits/success, red for credits/danger, amber warning, blue info, indigo AI features.

## Business Rules

Overhead Rate: Shared OpEx Pool = Total Merit 6000-series OpEx minus 10% Owner Group minus 100% Deal Team minus 100% Direct Assigned. OH Rate = Pool / (Production Employees x 150 hrs/mo). Bill Rate = Employee Hourly + OH Rate. Burdened Cost = Base/12 + 7.65% FICA + 3.50% WC + $680/mo benefits.

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
