# MeritBooks — Production Cutover Checklist

**Status:** NOT YET EXECUTED. Production currently runs, on purpose, on the **DEV Clerk
instance** and the shared dev Supabase project. This document is the plan to move it onto a
dedicated production stack safely. Do **not** start until every item in §1 is ready.

**Why this exists:** the previous cutover attempt failed because the Clerk **publishable and
secret keys were crossed** (`pk_live` where `sk_live` belonged and vice versa). The app looked
broken with no obvious cause. §3 adds an explicit pairing check so that specific mistake cannot
recur.

---

## 1. Pre-flight — everything below must be TRUE before you touch production

- [ ] **Dedicated production Supabase project exists** (separate from the current dev project
      `npqeijipggtuduhkejxq`). Its database has every migration applied, in order, through the
      latest number. Confirm with `list_migrations` on the new project.
- [ ] **Production Clerk instance exists** for the real app domain, with the **`org_id` claim**
      configured in the session token (this retires the temporary single-membership fallbacks).
- [ ] **Supabase Third-Party-Auth trust on the NEW prod Supabase project points at the PROD
      Clerk domain** (not the dev Clerk domain).
- [ ] **Anthropic API key is funded / re-enabled** (the account is currently disabled — document
      AI will error until this is fixed, cutover or not).
- [ ] **A rollback note is written**: the exact current values of every env var you are about to
      change, saved somewhere you can paste back from in under a minute.

## 2. Environment variables to set on the Vercel `production` environment

Set these on `meritbooks-web` (production scope). Values come from the **prod** Clerk and **prod**
Supabase projects — never the dev ones.

Clerk:
- [ ] `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` = prod Clerk **publishable** key (`pk_live_…`)
- [ ] `CLERK_SECRET_KEY` = prod Clerk **secret** key (`sk_live_…`)

Supabase:
- [ ] `NEXT_PUBLIC_SUPABASE_URL` = prod project URL
- [ ] `NEXT_PUBLIC_SUPABASE_ANON_KEY` = prod anon/publishable key
- [ ] `SUPABASE_SERVICE_ROLE_KEY` = prod service-role key

App + integrations:
- [ ] `NEXT_PUBLIC_APP_URL` = the real production URL (e.g. `https://app.meritbooks.app`)
- [ ] `EVENT_WORKER_SECRET` = a fresh secret (used by the internal event worker)
- [ ] `ANTHROPIC_API_KEY` = the funded key
- [ ] `INVOICE_FROM_EMAIL` = the address invoices send from
- [ ] Resend API key = rotated to the production key
- [ ] Stripe + Plaid keys = production keys (only if going live on real money movement)

## 3. The key-pairing safety check (do this BEFORE redeploying)

This is the check that would have caught last time's failure. Both keys must be from the **same**
Clerk instance and each must be the **correct type**.

- [ ] `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` starts with **`pk_`** (NOT `sk_`).
- [ ] `CLERK_SECRET_KEY` starts with **`sk_`** (NOT `pk_`).
- [ ] Both are `_live_` (production), not `_test_` (dev). A `pk_test`/`sk_live` mix means you
      grabbed one key from the wrong instance — stop and re-copy both from the prod Clerk
      dashboard in one sitting.
- [ ] The publishable key's embedded instance matches the secret key's instance (copy both from
      the *same* Clerk application's API-keys page, top to bottom, in one go — do not assemble
      them from two different tabs).

> Rule of thumb: `pk_` = **p**ublic (safe in the browser). `sk_` = **s**ecret (server only). If
> the one named `PUBLISHABLE` doesn't start with `pk_`, they're crossed.

## 4. Cutover

- [ ] Trigger a **clean production rebuild** (env-var changes only take effect on a fresh build;
      the `NEXT_PUBLIC_*` values get inlined at build time). Push a trivial commit or use Vercel's
      "Redeploy" with cache cleared.
- [ ] Wait for the deployment to reach **READY** (that means `next build` — the full typecheck —
      passed).

## 5. Smoke test on the live prod URL (before telling anyone it's live)

- [ ] Load the app — you land on sign-in, not a blank/error page.
- [ ] Sign in with a **prod** Clerk account. (Dev accounts will NOT exist on the prod instance —
      you may need to create the first prod user.)
- [ ] After login you reach the dashboard (not bounced in a redirect loop — that symptom means
      the `org_id` claim isn't resolving).
- [ ] Pick a company in the top bar; a processing page (e.g. Bank Feed) loads scoped to it.
- [ ] Open one report (e.g. Trial Balance) and confirm numbers render.
- [ ] Upload a document to confirm the storage path works (AI extraction will still error until
      the Anthropic account is funded — that's expected and separate).

## 6. If anything is wrong — roll back fast

- [ ] Paste the saved dev values (from §1) back into the Vercel env vars.
- [ ] Redeploy. You are back on the known-good dev-Clerk state within one build.
- [ ] Do not debug live under pressure — revert first, investigate after.

---

### Notes / known state at time of writing

- Parked empty prod tenant already exists: org `eb3d8087-7798-480d-9617-bdf73f63918a` (1 location),
  bound to prod Clerk. The working dev tenant is `1d1aa1ef-4218-4187-a622-4a80da1a9e11`.
- The management/parent entity is identified by a real flag now
  (`core.locations.is_management_company`), not a hardcoded name — set it explicitly on the
  intended parent entity in the new prod project.
- This checklist is a plan only. Steps that move money, change auth, or run migrations must be
  performed by Mike (or under his explicit direction), not autonomously.
