# MeritProjects — G0′ App Stand-Up · Ship Runbook

This package adds the standalone **`apps/projects`** app and the renumbered proj
migrations to the meritbooks monorepo. It is **additive** — it touches nothing in
`apps/web` (Books) and applies only `proj.*` objects to the shared DB. Nothing here
was merged to `main` or applied to Supabase for you; you drive both, per your rules.

## What's in the package
```
apps/projects/                         # standalone Next.js app (@meritbooks/projects)
packages/supabase/migrations/066_proj_seam.sql
packages/supabase/migrations/067_proj_contract_progress_standalone.sql
```
`066`/`067` are your existing `0001`/`0003` proj migrations, renumbered onto the
shared set. Verified: they create only `proj.*` + FKs to **existing** `core`
objects and `public.get_org_id()` — no `core` stubs, no collisions.

## Ship steps (migrations to Supabase FIRST, then code — your rule)

1. **Branch** (off `main`):
   ```bash
   cd ~/Projects/meritbooks
   git checkout -b meritprojects/g0-app-standup
   ```
2. **Drop the files in** — extract the tarball at the repo root:
   ```bash
   tar xzf meritprojects-g0-scaffold.tar.gz
   ```
3. **Install** (npm workspaces picks up `apps/projects`):
   ```bash
   npm install
   ```
4. **Apply migrations to Supabase FIRST**:
   ```bash
   npm run db:migrate      # supabase db push -> applies 066 + 067
   ```
5. **Expose the `proj` schema to PostgREST** (Supabase Dashboard → Project Settings →
   API → *Exposed schemas* → add `proj`). Not needed for the G0′ health check (it
   reads `core`), but G1+ read `proj.*` via the client, so do it now.
6. **Env** for the new app — copy `apps/projects/.env.example` to
   `apps/projects/.env.local` and fill with the **same Clerk instance and same
   Supabase project as Books** (one DB, one auth).
7. **Enable the module on your test org** (else the entitlement gate blocks the app):
   ```sql
   update core.organizations
     set entitlements = coalesce(entitlements, '{}'::jsonb) || '{"projects": true}'::jsonb
     where id = '<your-test-org-uuid>';
   ```
8. **Run it**:
   ```bash
   npm run dev --workspace apps/projects      # local smoke test
   ```
9. **Standalone deploy** — new Vercel project, **Root Directory = `apps/projects`**,
   same env vars. It ships as its own Vercel app (sellable on its own), sharing
   `packages/core-ai` + the one Supabase.

## G0′ exit criteria (verify)
- Sign in → `/` dashboard renders inside the entitlement gate (a Books-only org is
  refused with the "isn't enabled" screen — proves standalone/bundle gating).
- `GET /api/health` → `{ ok: true, module: "PROJECTS", entitlements: {…} }`
  (proves Clerk → RLS-scoped DB read of the caller's own org).
- `GET /api/ai/ping` → `{ gatewayImportable: true, … }`
  (proves the Core AI gateway resolves via **in-process import** — no HTTP bridge).

## Assumptions I made (verify these)
- `api-handler.ts` faithfully reproduces the Books wrapper (auth fails closed,
  RLS-scoped `createAuthedSupabase`). Diff against `apps/web` if you want them identical.
- Tailwind tokens are duplicated from Books' design system. A later gate should
  extract a shared `@meritbooks/tailwind-preset` so they never drift.
- `core.organizations` is REST-exposed and org-readable under RLS (Books relies on
  this). If the health route returns an RLS error, add the SELECT policy/grant.
- `/api/ai/ping` proves **import resolution only**. G1 wires the full
  `runAiGateway(deps, req)` metered call that writes `core.ai_usage_log`
  as `module='PROJECTS'`.

## What this is NOT
No features yet — G0′ is app stand-up. Leads/estimates/jobs/schedule/billing are
G1–G11 per the Revised Master Build Plan. Nav items are visibly "soon" until their
gate ships.
