# Merit Projects v2 — handoff (2026-10-21)

## 1. State
- **Live DB (Supabase `npqeijipggtuduhkejxq`):** `pm` chain **1100–1109 applied** (261 functions, 148 tables/views); `proj` EXECUTE locked (1007); Books identity lock 154 live; `pm` exposed in PostgREST.
- **Repo (`main`):** foundation `adc0fcd`, app `cc0adb4`, seam doc `76a328f`, parties+labor `cd31995`, dealer schema + demo seed `e4a5d84`. **Pending delivery:** dealer screens (`5b118a1` in the cloud clone; tarball `pv2-dealer-ui.tgz` sent — commit on the laptop when it reconnects).
- **Vercel:** `meritbooks-projects` READY on `cd31995`+; env added `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in`, `NEXT_PUBLIC_BOOKS_URL=https://books.meritmgt.com` (take effect on next deploy). Domains `projects.meritmgt.com` / `books.meritmgt.com` added; **DNS CNAMEs pending at GoDaddy** (`projects` → `e1d197bf1a58fe6e.vercel-dns-016.com`, `books` → `b3537422edb6475e.vercel-dns-016.com`).
- **Demo data live** in the test org: Northwind (commercial_gc), Coho (flooring), Acme (field_service) — 6 jobs each, 3 real / 3 sample (`packages/supabase/seed/pm-demo/`).

## 2. How migrations are applied (the connector blocks SQL containing "delete"/"drop")
Checksum-pinned runner: `extensions.http_get` the file from GitHub at a pinned commit, compare sha256, `execute` it, record in `supabase_migrations.schema_migrations`. Template: `/home/claude/runner/apply.sql`. Always apply the `pm` chain in order.

## 3. Owner rulings (binding)
- D7a customers/vendors = one shared core master; Projects creates via `pm.create_customer`/`pm.create_vendor`.
- D9 labor: job cost = payroll + burden (Books allocates actual payroll by hours); estimating rate adds overhead; overhead earned in gross margin.
- Domains: projects./books.meritmgt.com.
- Dealers: Projects replaces c-Systems (store); Books keeps money (floor plan, GL, AR/AP, OEM credits) — `docs/projects/BOOKS-PROJECTS-INTERACTION.md`.
- Books stands alone; Projects-fed features switch Books' own entry path off only when Projects is on.

## 3a. Expert panel and Wave 0a (2026-10-22)
- Owner stopped building and convened a 10-seat expert panel; spec approved ("yes i approve"):
  Claude Doc https://claude.ai/artifact/9qKLtgGAS79oGM9DLUcs5Z, register merit-projects-feature-register.xlsx,
  seat files in the claude.ai Project (`claude/meritprojects-panel-01..10`). Build order: Wave 0 foundation →
  Wave 1 shared core → industry waves (field service, residential, dealer, flooring+design, manufacturing,
  development, commercial).
- Wave 0a (roles, job access, money visibility): spec `docs/projects/WAVE0-ACCESS-FOUNDATION-SPEC.md`;
  migration `1110_pm_access.sql`; registry `packages/projects-access`; app `lib/access/*`, route() requires
  `access`, per-persona rails/homes, Settings → Team (job teams, Projects-only flag, preview-as).
  Tests: projects-access 121/121 (incl. app-queries as 9 personas), Projects 793/793, Books 4,255 pass.
  Independent security review: all findings fixed and re-verified (lock-out found in review fixed by the
  explicit `core.memberships.projects_only` flag). Books note: `docs/projects/BOOKS-NOTE-1110-PROJECTS-ACCESS.md`.
- Parked pre-stop WIP (unvetted, not in repo): `/home/claude/wip-prestop/` (1111 schedule, 1112 CRM, 1113 AI
  migrations + lib/pm/crm, lib/pm/schedule, lib/ai/*). Re-evaluate in Wave 1; they must follow 1110's policy classes.
- Open decisions from the spec (§11): field app native vs installable web app; equipment internal rates;
  burden timing; dealer seam items; CPA checks.

## 4. Open / next
1. Commit dealer screens on laptop; verify deploy; chrome audit once DNS resolves (sign-in required — Clerk dev).
2. Books-side seam work (`BOOKS-SEAM-CHANGES-FOR-PROJECTS-V2.md`) — Books session accepted; flags `books_seam_version=2`, `books_dealer_seam` gate emission.
3. A second approving user is needed to see approvals (COs, pay apps, subcontracts, time) and invoices flow to Books (preparer ≠ approver).
4. AI: no `ANTHROPIC_API_KEY` in Projects env and the Anthropic org is disabled — onboarding/intake run rules-only ("AI assist paused").
5. Clerk production on `meritmgt.com` for one sign-in across both apps.
6. Legacy `proj` drop after one close cycle (`1199`); dealer `DEALER_DEPOSIT_REQUEST` needs Books agreement.

## 3b. Shared records, CRM leads, Merit Workforce phone app (2026-10-24)
- Wave 0a LIVE: 1110 applied (checksum runner, commit 035ee4c), projects.meritmgt.com READY, no runtime errors.
- Owner rulings: spec approved, build; field app = native phone app (one app: Merit Workforce, shared with Books' employee cards);
  Projects has its own CRM lead flow on a shared `crm` schema so a future Merit CRM uses the same rows.
- Design: docs/suite/SHARED-RECORDS-CRM-PROJECTS-BOOKS.md (one record per customer/contact/site/vendor; match at the door;
  duplicate review + merge; nightly tie-outs "Ties to Books").
- Built: migration 1111_shared_records.sql (core.contacts/sites/duplicate_reviews, crm schema + per-pack pipelines, matcher,
  merge, safety-net trigger, convert_lead, customer 360, job/company tie-outs, supervisor punch grant, field idempotency
  indexes); Projects Leads board/list/page, Customers list + 360, Possible duplicates, Ties to Books panels, matching on every
  Projects create door; apps/workforce/mobile (Expo, Clerk, encrypted offline SQLite queue, Today/Clock/Log/Photos/Checklist/
  Punch/Crew/Me) + apps/projects/src/app/api/field/**.
- Tests: projects-access 188/188 (app reads as 11 personas), Projects 967/967, Books 5,011 pass. Security review x2: all fixed.
- Apply steps: run 1111 via the checksum runner AFTER the commit is on GitHub, then add `crm` to authenticator
  pgrst.db_schemas ('public, core, proj, pm, crm, graphql_public') and `notify pgrst, 'reload config'`.
- Open: commitments and time tie-outs show "pending" (Books doesn't match bills to Projects commitments or record payroll
  hours by job); onboarding import doesn't use the matcher yet (safety-net trigger catches duplicates); phone app needs Apple
  Developer + Google Play + Expo accounts and Clerk email/SMS code sign-in (apps/workforce/README.md); Books needs
  /api/w/me/pay and /commissions for the Me cards; ask Books to call core.match_parties on its create doors.
