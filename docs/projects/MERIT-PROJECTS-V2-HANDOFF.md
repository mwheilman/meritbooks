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

## 4. Open / next
1. Commit dealer screens on laptop; verify deploy; chrome audit once DNS resolves (sign-in required — Clerk dev).
2. Books-side seam work (`BOOKS-SEAM-CHANGES-FOR-PROJECTS-V2.md`) — Books session accepted; flags `books_seam_version=2`, `books_dealer_seam` gate emission.
3. A second approving user is needed to see approvals (COs, pay apps, subcontracts, time) and invoices flow to Books (preparer ≠ approver).
4. AI: no `ANTHROPIC_API_KEY` in Projects env and the Anthropic org is disabled — onboarding/intake run rules-only ("AI assist paused").
5. Clerk production on `meritmgt.com` for one sign-in across both apps.
6. Legacy `proj` drop after one close cycle (`1199`); dealer `DEALER_DEPOSIT_REQUEST` needs Books agreement.
