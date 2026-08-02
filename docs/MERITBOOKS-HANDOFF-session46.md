# MeritBooks — Session 46 Handoff

**Date:** 2026-08-02
**Supersedes:** session 45. Use this as the current source of truth for build state.
**Companion:** `docs/canon/CANON-ANCHOR.md` (re-ground anchor), `docs/NORTH-STAR.md`
(product spine), the AI-capability master (`docs/discovery/AI-CAPABILITY-MATRIX.md` +
`INTEGRATION-MAP.md`), and the FPBs (invoices, financial-reports, bank-reconciliation,
payroll, financial-control-exceptions, team-performance, identity-multitenancy,
tenant-model-consolidation-analytics, payments-fees, nl-copilot).

> **Coordination note (read first):** two Cowork sessions commit to this one repo —
> **MeritBooks** (this handoff) and **MeritProjects** (Module 6, the `feat(projects): …`
> commits). Disjoint workstreams sharing one git history, one Supabase, one migration
> sequence. Rules in force: **path-scoped `git add`** (never `git add -A`), and **disjoint
> migration bands — Books `0xx`, Projects `1xxx`.** Ignore the `projects` commits except
> where they touch the shared spine.

---

## 1. Headline

The session that **opened the two remaining AI modalities to real depth** — supervised
**agent orchestration (M9)** and generalized **learning/memory (M14)** — and **upgraded
search (M13) to true Postgres full-text retrieval**, while **closing the two Invoices FPB
deltas** so Invoices reaches its FPB bar. Session 45 built the month-end close/controls/tax/
workflow spine; Session 46 (a) **shipped a supervised agent-orchestration runner** with
per-step AUTO / PROPOSE / HUMAN_GATE audit and stood up **one loop (AP intake)**, (b)
**generalized the single vendor→GL categorization memory into an org-scoped
`learned_preferences` store** spanning categorization, close-cadence, and report prefs,
(c) **upgraded `/search` from a keyword `.ilike` scan to GIN-indexed tsvector full-text
retrieval** (degrade-safe), (d) **closed the two Invoices FPB deltas** — a `BAD_DEBT_EXPENSE`
account role so write-offs resolve the expense account **by role**, and `v_ar_aging` now
**excludes `WRITTEN_OFF`** — and (e) added **read-only duplicate-vendor detection** on the
vendor 360 plus confirmed the **`/api/vendors` column-drift fix**.

The session opened with a **single-cause build-ERROR streak**: `ROLE_DEFAULT_NUMBER` was
consumed by `provision-accounts` and `prepaid-asset` import paths but never exported from
`account-roles`. Commit `76bca49` exports it and unblocks the whole streak — every prior
ERROR build in the run shared that one missing export.

Everything below is on `main`. **Production HEAD is `f056033`** (`chore(migrations+nav):
apply 095–098 + Agents nav`); it is **Vercel state READY**, so `next build` — the
authoritative full-project typecheck — is green at HEAD. The verifier reported the combined
HEAD **typechecks clean and every new lane is degrade-safe**. Books migrations **095–098**
were applied to Supabase first, then the dependent code committed.

---

## 2. What shipped this session (Books)

### M9 — supervised agent orchestration (framework + first loop)

- **Agent orchestration runner** (`7b57274`, migration 096: `agent_runs` + `agent_run_steps`)
  — a multi-step supervised runner (`lib/agents/runner.ts`) with per-step audit. Steps are
  **AUTO / PROPOSE / HUMAN_GATE**; the runner **honors the tenant autonomy dial + kill switch
  (M10)** and **NEVER posts money/GL directly** — money steps flow through the existing
  deterministic engines + human approval gates (canon §3). RLS org-isolation via
  `get_org_id()`; degrades safe (ephemeral run) if the tables are absent.
- **First loop: AP intake** — the AP-intake pipeline (email→bill→code→approve) is wired as the
  first recipe on the runner. **HONEST SCOPE:** this is the framework + **ONE loop**. The
  order-to-cash, close-run, and pay-run recipes are **next** (task #105), not yet built.
- **Nav:** `Agents` added (`f056033`).

### M14 — generalized learning / memory store

- **`learned_preferences`** (`a8ed294`, migration 097) — generalizes the single vendor→GL
  categorization memory (Session 44) into a **reusable, org-scoped preference/memory store**
  the whole app can read. Scopes: **CATEGORIZATION, CLOSE_CADENCE, REPORT_PREFS**, TONE,
  METHOD_SSP. Learning **only INFORMS proposals/defaults — it never posts or approves**
  (canon §3). Close-cadence learning and report-preference learning ride the same store.
  RLS org-isolation; unique on `(org_id, scope, key)`; degrades safe (reads null / writes
  no-op) if absent. **HONEST SCOPE:** the modality is now **opened broader than vendor-memory
  but is NOT exhaustive** — personalization beyond these scopes is still ahead.

### M13 — search upgraded to Postgres full-text retrieval

- **`/search` → GIN tsvector FTS** (`d6bc198`, migration 095) — each searchable table
  (`gl_entries`, `bank_transactions`, `invoices`, `bills`, …) gets a **STORED generated
  `tsvector` column + GIN index** (weighted A/B/C/D), replacing the keyword-only `.ilike`
  scan. `lib/search/search-service.ts` **DEGRADES SAFE**: until the columns exist it falls
  back to `.ilike`, so there is no window where search breaks. **HONEST SCOPE:** this is
  strong **LEXICAL full-text** (stemming, prefix, phrase, weighting) — it is **NOT
  embeddings/vector semantic search**. That's a deliberate choice (deterministic, no model
  call, no drift); vector retrieval remains a future option if warranted.

### Invoices → FPB deltas closed

- **`BAD_DEBT_EXPENSE` account role + AR-aging write-off exclusion** (`4b73b2f`,
  migration 098): (a) `v_ar_aging` now **excludes `WRITTEN_OFF`** invoices (was only
  PAID/VOIDED/DRAFT), reproduced from the live view definition (security_invoker per
  migration 068, joins `core.customers`/`core.locations`); (b) `BAD_DEBT_EXPENSE` registered
  in the controlled account-role vocabulary + **account 6670 created** + role map re-seeded,
  so invoice write-offs (`lib/invoices/write-off-posting.ts`) resolve the expense account
  **BY ROLE** instead of a hardcoded number (canon "reference by role, not number"). **These
  are the two deltas task #22 was blocked on** — Invoices now meets its FPB bar on these
  items; a final FPB read-through/verifier confirmation is the remaining check.

### Vendors

- **Duplicate-vendor detection on the vendor 360** (`69b395e`) — read-only, detect-only
  surfacing of likely-duplicate vendors. Same commit **confirms the `/api/vendors`
  `core.vendors` column-drift is fixed** — the path that previously errored (referencing
  columns not on the live table) now reads clean.

### Build fix (unblocked the ERROR streak)

- **Export `ROLE_DEFAULT_NUMBER`** (`76bca49`) — from `account-roles`. This single missing
  export was the **whole cause of the preceding build-ERROR streak** (consumed by
  `provision-accounts` + `prepaid-asset` imports). Exporting it turned the streak green.

---

## 3. Data / infra changes (reproducibility notes)

- **Books migrations applied to Supabase this session (Supabase first, then code):**
  - `095_search_fts_tsvectors.sql` — STORED generated `tsvector` columns + GIN indexes on
    the searchable tables (M13).
  - `096_agent_runs.sql` — `agent_runs` + `agent_run_steps` for the supervised runner (M9);
    RLS org_isolation.
  - `097_learned_preferences.sql` — generic org-scoped learning/memory store (M14); RLS
    org_isolation; unique `(org_id, scope, key)`.
  - `098_ar_aging_exclude_writeoff_and_bad_debt_role.sql` — `v_ar_aging` excludes
    `WRITTEN_OFF` + `BAD_DEBT_EXPENSE` role/account seed (Invoices FPB deltas).
  - **Verified applied to Supabase** (`list_migrations`): 095/096/097/098 all present
    (versions `20260802173437`–`20260802173514`).
- Prior Books migrations remain applied; the sequence still **skips `072`**. Projects
  `1001–1006` are owned by the MeritProjects workstream — Books does not own them.
- **Vercel `next build` is the authoritative full-project typecheck.** Production **HEAD
  `f056033` is Vercel state READY** (green). The build-ERROR streak that preceded it all
  shared a **single cause** — the missing `ROLE_DEFAULT_NUMBER` export — fixed in `76bca49`.
  The verifier reported the combined HEAD **typechecks clean** and every new lane
  (search, agents, learning) is **degrade-safe**.
- The standing pre-existing harness failures are **unchanged and NOT regressions:** the
  PGlite migration-replay harness fails when pglite isn't installed in the sandbox, and
  `src/test/tenant-isolation.test.ts` has a parse error — both predate session 42.
- **Key ids unchanged:** org `1d1aa1ef-4218-4187-a622-4a80da1a9e11`; Supabase project
  `npqeijipggtuduhkejxq`; Clerk user `user_3BwDOygB7TuYWcrUUt87GOVvQV1`; Vercel team
  `team_2EwoHwR0BcH6GNjMjCbMaVAW`, project `meritbooks-web`.
- **Auto-push loop still live** on Mike's machine (ships `main` commits automatically). Claude
  cannot push from the sandbox and must not handle a token.

### Legacy duplicates still flagged (do NOT delete — carried forward from S45)

- **`/recurring`** — superseded by **`/recurring-journal-entries`**.
- **`/invoices/collections`** — superseded by **`/collections`**.
- Both still exist on disk. Leave in place until a deliberate cleanup slice; do not delete now.

---

## 4. Open items — DO NOT FORGET

### This session's follow-ups
- [ ] **Invoices final FPB check (task #22)** — the two write-off/aging deltas are **closed**
      (`BAD_DEBT_EXPENSE` role + `v_ar_aging` excludes `WRITTEN_OFF`). Remaining is the final
      FPB read-through / verifier confirmation that Invoices now meets its full FPB bar.
- [ ] **M9 loop expansion (task #105)** — build the **order-to-cash, close-run, and pay-run**
      recipes on the runner (only the AP-intake loop exists today).
- [ ] **Browser-verify the new verticals (task #18)** — chrome-auditor pass over the
      newly-live/updated pages (Agents, upgraded search, learning-informed defaults, vendor
      dedupe) plus the Session-45 spine, on the deployed app.
- [ ] **Verifier concerns (task #52)** — remaining direct-key reads + the `/api/accounts` org
      filter noted by the verifier; confirm all closed.

### Still-open gates
- [ ] **Identity gate #9 — MANUAL residual** (org resolution is DONE & live since S45): stand
      up the **Clerk production instance** for **app.meritbooks.app** + JWT template (with the
      `org_id` claim so the native-`o.id` fallback can be retired), set **`EVENT_WORKER_SECRET`**,
      rotate the **Resend key**. Plus (Claude-side) **split `payments` into per-route money
      keys** (task #56), control-route RBAC, `core.assignments` per-user scoping, event-worker
      read/"peek" scoping, and location-scoped RLS.
- [ ] **Per-route money permissions / SoD split (task #33 / task #56)** — split the single
      `payments` permission so a `check_processor` regains **check-run** without **payroll-release**.
- [ ] **Payroll GATE 12.3 Phase B (task #34)** — blocked on provider pick (**Check vs. Gusto**):
      releaser ≠ preparer at release, payroll double-post guard, live Check sandbox.
- [ ] **GATE 4 — AP OCR / email ingestion** — blocked on Azure creds from IT (provider-agnostic
      AP intake queue built and Azure-ready; the M9 AP-intake loop rides it).

### Known drift / deferred (carried forward)
- [ ] **Drop-and-parse follow-ups (task #71)** — the **`documents` storage bucket EXISTS**
      (created S45); remaining is wiring the last parse paths' file persistence onto it.
- [ ] AP line coding falls back to acct 6660 (Misc OPEX) when no account resolves.

### Mike's manual to-dos (Claude can't do these)
- [ ] **Ratify the Master-Doc amendments (task #19)** — `docs/PROPOSED-MASTER-DOC-AMENDMENTS.md`.
- [ ] **Pick the payroll provider** — Check vs. Gusto — to unblock Payroll Phase B (task #34).
- [ ] **Rotate the Resend API key** + set **`INVOICE_FROM_EMAIL`** for live invoice/statement email.
- [ ] **Add `app.meritbooks.app`** as a domain to the **`meritbooks-web`** Vercel project.
- [ ] **Provision the Clerk PRODUCTION instance** for `app.meritbooks.app` — DNS records +
      allowed redirect URLs + JWT template (with `org_id` claim), then register Supabase.
- [ ] **Set `NEXT_PUBLIC_APP_URL=https://app.meritbooks.app`** and **`EVENT_WORKER_SECRET`** in Vercel.
- [ ] **Provide Azure creds** to unblock GATE 4 AP-OCR / email ingestion.

> ⚠️ **Marketing site is a SEPARATE Vercel project (`meritbooks-marketing`) — do NOT touch it.**
> The apex **`meritbooks.app` stays with marketing**; the app gets the **`app.` subdomain only**
> (`app.meritbooks.app`). Never point the apex at `meritbooks-web`.

---

## 5. Direction — what's next

> **A Session-47 wave is already IN FLIGHT** — the next scribe continues from there. In-flight
> lanes: **M9 loop expansion** (order-to-cash / close-run / pay-run recipes), **reconciliation
> Wave B** (line check-off/lock + plug/stale detector + rec-memo), **explain-this-X narrative
> drawer** (M7 breadth), **collections depth** (pay-date prediction + escalating dunning), and
> an **AP money-out MVP** (disbursement batch + NACHA/CSV export + human release). See tasks
> #105–#109.

Per the canon gate order and `NORTH-STAR.md` (autonomous engine + supervision/trust layer;
depth-first, one pipeline per parallel wave, behind an FPB):

1. **Expand the M9 runner beyond the AP-intake loop** — order-to-cash, close-run, pay-run
   recipes — keeping every money/GL step on the deterministic engines behind human gates.
2. **Land the MANUAL gate-#9 productionization** — Clerk prod instance for `app.meritbooks.app`
   (+ DNS, redirect URLs, `org_id` claim), `EVENT_WORKER_SECRET`, Resend key — then the
   Claude-side per-route money-permission split (task #56), `core.assignments`, event-worker
   read-scoping, and location-scoped RLS.
3. **Close the Invoices FPB (task #22)** with the final read-through now that the two deltas
   are in; continue Reports / Bank-Rec toward Complete behind their FPBs.
4. **Browser-verify the newly-live lanes** (task #18) and clear verifier concerns (task #52).
5. **Payroll Phase B** once the provider is picked (releaser ≠ preparer, double-post guard,
   live Check); **extend the control library toward EC-1..EC-13**; **grow M14 learning**
   beyond the current scopes.

Execution model unchanged: file-disjoint vertical slices, 3–5 concurrent builder/general-purpose
agents (all **opus 4.8**) in one message, shared spine single-threaded through the lead,
migrations to Supabase first, Vercel `next build` as the authoritative typecheck. **Two
concurrent workstreams (MeritBooks + MeritProjects) share the repo — path-scoped commits +
disjoint migration bands (Books `0xx` / Projects `1xxx`) are mandatory.**

---

## 6. Agents

Eight in `.claude/agents/` (builder, verifier, auditor, reviewer, designer, scribe, security,
chrome-auditor) plus SDK agents (general-purpose, Explore, Plan). **Every agent runs on `opus` —
`claude-opus-4-8` — no exceptions** (Owner directive, binding in CLAUDE.md §0.1). This session
ran concurrent `general-purpose`/builder waves on disjoint slices (M9 orchestration runner /
M14 learning store / M13 FTS search / Invoices write-off deltas / vendor dedupe / build fix),
with the pure engines and degrade-safe fallbacks checked by **verifier** (clean typecheck,
degrade-safe lanes). Note: the M9 runner's design keeps AI proposing and the deterministic
engines + human gates doing all money/GL — the canon §3 SoD line is preserved in the framework
itself.

---

## 7. Live state

- **Production HEAD: `main` @ `f056033`** (`chore(migrations+nav): apply 095–098 + Agents
  nav`) — **Vercel state READY** (the authoritative full-project typecheck is green). The
  preceding build-ERROR streak shared a **single cause** (missing `ROLE_DEFAULT_NUMBER`
  export), fixed in `76bca49`.
- Books migrations applied to Supabase this session: **095–098** (search FTS tsvectors,
  agent_runs, learned_preferences, AR-aging write-off exclusion + bad-debt role) — verified
  present via `list_migrations`. The sequence still skips `072`.
- **Identity gate #9 org resolution remains CLOSED live** (S45) — tenant resolved from the
  Clerk native `o.id` claim with auto-bind, first-org fallbacks removed. Residual is the
  MANUAL Clerk-prod work.
- Clerk↔Supabase active on the **dev** Clerk instance; auto-push loop running on Mike's machine.
- **Verification:** the verifier reported the combined HEAD **typechecks clean** and every new
  lane (M13 search, M9 agents, M14 learning) is **degrade-safe** (falls back / no-ops if its
  migration is absent). **Standing pre-existing harness failures — NOT regressions:** pglite
  not installed in the sandbox; `src/test/tenant-isolation.test.ts` parse error. Both predate
  this session.
- **A Session-47 wave is IN FLIGHT** (M9 loop expansion, reconciliation Wave B, explain-this-X,
  collections depth, AP money-out MVP) — the next scribe continues from there.

---

## 8. One-line for the next session

Start by reading `docs/canon/CANON-ANCHOR.md` then this file. Session 46 **opened the last two
AI modalities to real depth** — supervised **agent orchestration (M9)**: a runner with
AUTO/PROPOSE/HUMAN_GATE steps (migration 096) + **one AP-intake loop** (order-to-cash/close-run/
pay-run recipes are next), and generalized **learning (M14)** into an org-scoped
`learned_preferences` store (migration 097; categorization + close-cadence + report-pref) — plus
**upgraded `/search` to Postgres GIN full-text** (migration 095; strong LEXICAL, not embeddings,
degrade-safe) and **closed the two Invoices FPB deltas** (`BAD_DEBT_EXPENSE` role + `v_ar_aging`
excludes `WRITTEN_OFF`, migration 098) and added **vendor dedupe** on the 360 (+ `/api/vendors`
drift fix). The opening build-ERROR streak had **one cause** — a missing `ROLE_DEFAULT_NUMBER`
export — fixed in `76bca49`; **HEAD `f056033` is Vercel READY**. **Next (a S47 wave is already
in flight):** M9 loop expansion, reconciliation Wave B, explain-this-X, collections depth, AP
money-out MVP; plus the MANUAL Clerk-prod productionization for `app.meritbooks.app` (DNS +
`org_id` claim + `EVENT_WORKER_SECRET` + Resend key), the final Invoices FPB check (task #22),
browser-verify (task #18), and per-route money-permission split (task #56) — spec-first,
disjoint parallel slices, migrations-first, path-scoped commits alongside MeritProjects. **Do
NOT touch the separate `meritbooks-marketing` Vercel project; apex stays with marketing, app
gets `app.` only.**
