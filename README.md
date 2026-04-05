# MeritBooks

AI-native accounting platform for multi-entity portfolio management. Book of record for Merit Management Group's 17 portfolio companies.

**Module 1 of 12** in the Merit Enterprise Suite.

## Tech Stack

- **Frontend:** Next.js 14 (App Router), React 18, TypeScript, Tailwind CSS
- **Backend:** Next.js API Routes + Server Actions
- **Database:** PostgreSQL 16 on Supabase with Row-Level Security
- **Auth:** Clerk
- **Banking:** Plaid
- **AI:** Claude Opus 4.6 (Anthropic)
- **Monorepo:** Turborepo

## Project Structure

```
meritbooks/
├── apps/
│   └── web/                    # Next.js application
│       └── src/
│           ├── app/
│           │   ├── (app)/      # Authenticated routes (20 pages)
│           │   │   ├── dashboard/
│           │   │   ├── bank-feed/
│           │   │   ├── chart-of-accounts/
│           │   │   ├── journal-entries/
│           │   │   ├── reports/        # P&L, BS, TB
│           │   │   ├── vendors/
│           │   │   ├── chargebacks/
│           │   │   ├── close/
│           │   │   └── ...
│           │   ├── api/        # API routes
│           │   │   ├── gl/     # GL posting, trial balance
│           │   │   └── bank-feed/  # Transaction approval
│           │   └── sign-in/
│           ├── components/
│           │   ├── ui/         # Reusable design system
│           │   └── layout/     # Sidebar, Header
│           ├── hooks/          # useQuery, useMutation
│           ├── lib/
│           │   ├── services/   # GL posting, AI categorization
│           │   ├── validations/ # Zod schemas
│           │   ├── supabase/   # Client/server Supabase setup
│           │   └── api-handler.ts  # API route wrapper
│           └── styles/
├── packages/
│   ├── shared/                 # Types, constants, utilities
│   │   └── src/
│   │       ├── types/          # Database type definitions
│   │       ├── constants/      # COA hierarchy (251 accounts)
│   │       └── utils/          # Money formatting
│   └── supabase/
│       ├── migrations/         # 9 SQL migration files
│       └── seed/               # Seed script
└── turbo.json
```

## Getting Started

### Prerequisites

- Node.js 20+
- Supabase project (or local via `supabase start`)
- Clerk account
- Anthropic API key (for AI features)

### Setup

```bash
# 1. Clone and install
git clone https://github.com/mwheilman/meritbooks.git
cd meritbooks
npm install

# 2. Configure environment
cp apps/web/.env.local.example apps/web/.env.local
# Fill in Clerk, Supabase, and Anthropic keys

# 3. Run database migrations
cd packages/supabase
supabase db push  # or run migrations manually

# 4. Seed data
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx seed/index.ts

# 5. Start dev server
cd ../..
npm run dev
```

### Database

9 migration files creating ~50 tables with:
- 6 enforcement triggers (double-entry balance, period lock, control accounts, approved accounts, dimension validation, entry number generation)
- Row-Level Security on every table via `org_id`
- 9 reporting views (trial balance, income statement, balance sheet, GL detail, AP/AR aging, cash position, job profitability)

### Key Design Decisions

1. **All money stored as cents (bigint)** — no floating point anywhere
2. **Database-enforced double-entry** — `check_journal_balance()` trigger prevents unbalanced JEs
3. **Unified COA** — single chart shared across 17 entities, company-specific accounts isolated via `company_location_id`
4. **AI learning loop** — vendor pattern cache improves with every human correction
5. **Zod validation at API boundary** — typed input validation before any database operation
6. **Server components by default** — client components only where interactivity is needed

## Architecture Decisions Record

| Decision | Choice | Rationale |
|----------|--------|-----------|
| GL storage | Cents as bigint | Eliminates floating point errors in accounting |
| Auth | Clerk | Faster than building auth, supports org management |
| Database | Supabase (Postgres) | RLS for multi-tenant, real-time subscriptions, edge functions |
| AI model | Claude Opus 4.6 | Best reasoning for accounting categorization |
| Monorepo | Turborepo | Shared types between frontend and DB layer |
| Validation | Zod | Runtime type checking at API boundaries |
| CSS | Tailwind | Utility-first, consistent design system |
