# MeritBooks — Session 50 Handoff

**Date:** 2026-08-09
**Supersedes:** session 49. Use this as the current source of truth for build state.
**Companion:** `docs/canon/CANON-ANCHOR.md` (re-ground anchor), `docs/NORTH-STAR.md`
(product spine), the AI-capability master (`docs/discovery/AI-CAPABILITY-MATRIX.md` +
`INTEGRATION-MAP.md`), and the FPBs (invoices, financial-reports, bank-reconciliation,
payroll, financial-control-exceptions, team-performance, identity-multitenancy,
tenant-model-consolidation-analytics, payments-fees, nl-copilot).

> **Coordination note (read first):** two Cowork sessions commit to this one repo —
> **MeritBooks** (this handoff) and **MeritProjects** (Module 6, the `feat(projects): …`
> commits). Disjoint workstreams sharing one git history, one Supabase, one migration
> sequence. Rules in force: **path-scoped `git add`** (never `git add -A`), and **disjoint
> migration bands — Books `0xx`/`1xx` core band, Projects `1xxx`.** This session had **no
> Projects commits** in the Books range; all seven commits are Books.

---

## 1. Headline

A **product-breadth-then-integrity session.** With the AI account still dark, Session 50
first pushed the deterministic product surface **out to the credential boundary** — the
last customer-facing gaps that only need a live credential or provider to go live
(estimates→invoice, customer deposits, borrowing base, customer + vendor self-service
portals, 1099-MISC + FIRE e-file, an ACH/wire origination rail, a live sales-tax rate
engine, direct-API migration connectors, external-auditor access + PBC, error
observability, a reporting-basis overlay) — and then did the **most important thing of the
session: a read-only subledger-to-GL tie-out audit and its full remediation.** That audit
found several subledgers were **not tying to the general ledger** (most critically, AR was
posting to a broken account-number range that *excluded* the 1100 control account), and the
final commit fixes every one of them so **the subledgers tie to the GL by construction**. An
independent re-audit **confirmed all findings closed.** This is a material correctness
milestone for a book of record.

The arc, in commit order:

1. **Estimates→invoice, customer deposits (2420), borrowing base, role-based sidebar,
   rebuilt accounting-manager KPI dashboard, rev-rec unbilled-receivable (1180) accrual**
   (`2a36a0b`) — migrations **139** (estimates) + **140** (customer deposits). Also fixed the
   accounting-manager performance panel, which was **silently rendering empty** from an
   API-contract mismatch (the root of "no meaningful KPIs").
2. **Rev-rec accrual preview relaxed to view-only; unbilled receivable (1180) surfaced on AR
   aging** (`c9de267`) — a view-only role (e.g. CFO) can preview what would accrue; POST stays
   post-gated (SoD preserved). No migration.
3. **api-client double-`?` URL bug fix** (`4e3c674`) — `api.get()` was appending a second
   `?`+params onto URLs that already carried a query string, producing
   `/x?location_id=A?location_id=A` and a `uuid` cast failure on AR aging (and any
   report/page passing both an inline query and hook params). One-line-class root-cause fix.
4. **Unified collapsible AR aging** (`d2b438c`) — the parent is one "AR Aging" with COMBINED
   (billed + unbilled) per-customer totals; expand any customer to break into a Billed child
   and an Unbilled (contract asset, 1180) child, then to invoice/job lines. No amount is
   recomputed (billed stays subledger, unbilled stays GL). No migration.
5. **Customer + vendor portals, 1099-MISC + FIRE e-file, ACH origination rail, live sales-tax
   engine, direct-API migration connectors** (`c8c3b22`) — migrations **141–144**. Six
   product-gap builds, each to the credential boundary (nothing blocks on Claude; each needs
   Mike's live credential/provider to go live).
6. **External auditor access + PBC, error observability, performance pagination + indexes, UX
   polish sweep, reporting-basis overlay (Accrual|Tax|Cash|Custom)** (`9c0ee28`) — migrations
   **145–148**.
7. **INTEGRITY REMEDIATION: subledger-to-GL tie-out + one-click cash/accrual + security
   mediums** (`e2702c5`) — migration **149**. The correctness centerpiece (details in §2).

⚠️ **Push state at time of writing:** HEAD is **`e2702c5`**; **`origin/main` is `d2b438c`**
— the working tree is **ahead 3** (`c8c3b22`, `9c0ee28`, `e2702c5` not yet pushed). The
auto-push loop on Mike's machine ships them within ~30s each; earlier commits are Vercel
**READY**, the last three will build once pushed. Migrations 139–149 were applied to Supabase
**first**, then the dependent code committed (canon migration rule). Confirm the final commits
reach Vercel **READY** before trusting their `next build` typecheck.

---

## 2. What shipped this session (Books)

Commit range `6a05626..e2702c5` (7 Books commits; **no** Projects commits in this range).

### Estimates, customer deposits, borrowing base, role-nav, manager KPIs, unbilled accrual (`2a36a0b`, migrations 139 + 140)
- **Estimates / Quotes** (migration **139** `estimates` + `estimate_lines`): full lifecycle
  (DRAFT/SENT/ACCEPTED/DECLINED/EXPIRED) + **convert-to-invoice that CALLS the existing
  `createInvoice` path** (posts through the unchanged GL path); atomic double-convert guard;
  estimate PDF; win-rate/pipeline strip. The estimate is a **non-posting** doc — only the
  converted invoice posts.
- **Customer deposits / retainers** (migration **140** `customer_deposits` +
  `customer_deposit_applications`): take (DR Cash / CR **2420**), apply-to-invoice (DR 2420 /
  CR A/R, over-application impossible via code + CHECK + optimistic lock), refund remainder
  (DR 2420 / CR Cash); per-customer outstanding roll-up + subledger↔GL **2420** tie-out. All
  JEs balanced through `postJournalEntry`; gated on invoices create/approve.
- **Borrowing-base calculator** (read-only): reuses `v_ar_aging` + inventory valuation;
  eligible AR (past-due carve-out, concentration cap, cross-age) × advance rate + eligible
  inventory × rate with sublimit; `min(base, facility) − outstanding`; certificate breakdown +
  concentration risk flag; PDF/XLSX export via existing exporters.
- **Role-based sidebar**: nav filters by effective `view` permission per item (route→feature
  map), hides empty groups, never hides Home; **fail-SAFE** on a missing payload (page-guard /
  require-permission remain the server enforcement boundary). ⚠️ Custom roles fall through to
  show-all (fail-safe), so an external auditor may see links their page-guards then block — a
  UX-polish follow-up, not a security hole.
- **Accounting-manager performance dashboard REBUILT**: the panel was **silently rendering
  empty from an API-contract mismatch** — the actual root of "no meaningful KPIs." Now:
  throughput **by transaction count and by dollars per person**, close-schedule adherence
  (on-time %, days-to-close), regulatory filing adherence (sales-tax + compliance on-time %),
  leaderboard with target-vs-actual RAG + date-range selector.
- **Rev-rec unbilled accrual** (owner ask): for underbilled jobs (earned > billed), an explicit
  action posts **DR Unbilled Receivable / Contract Asset (1180) / CR Revenue** for the delta;
  adjust-to-target so it never double-counts the automated rev-rec run and self-reverses when
  billing catches up; idempotent per job+period (mig-064 unique ref); ties 1180 to WIP
  under-billing. Gated `journal_entries` create(propose) / post(approve).

### Rev-rec preview relaxed + unbilled surfaced on AR aging (`c9de267`, no migration)
- Rev-rec unbilled-accrual **PREVIEW (GET)** relaxed from `journal_entries:create` to
  `journal_entries:view` (a view-only CFO can preview); **POST stays `journal_entries:post`**.
  SoD preserved.
- AR aging shows the **Unbilled Receivable (1180)** as its own section: balance read directly
  from posted `gl_entry_lines` for the resolved `UNBILLED_RECEIVABLE` account (ties to the
  balance sheet), aged by accrual entry_date, per-customer/per-job attribution, plus a combined
  "Total Receivables (billed + unbilled)" row. Billed `v_ar_aging` untouched.

### api-client double-`?` fix (`4e3c674`, no migration)
- `api.get()` blindly prepended `?`+params even when the URL already had a query string,
  producing `/x?location_id=A?location_id=A` → `invalid input syntax for type uuid`. Now splits
  on `?`, merges via `URLSearchParams.set` (de-dupes), reassembles once. Fixes AR aging and any
  report/page passing both an inline query and hook params.

### Unified collapsible AR aging (`d2b438c`, no migration)
- New pure `lib/reports/ar-aging-merge.ts` (`mergeArAging`) joins billed (`v_ar_aging`) and
  unbilled (GL 1180) by customer into a combined-by-customer model with per-bucket sums +
  billed/unbilled children; no amount recomputed; grand totals tie band-by-band. Report rewritten
  to combined parent rows with per-row expand (aria-expanded chevrons) + global expand/collapse;
  export (`build-model`) emits the same unified model to CSV/XLSX/PDF. Route shape unchanged.

### Portals, 1099-MISC, ACH rail, sales-tax engine, ERP connectors (`c8c3b22`, migrations 141–144)
- **Customer self-service portal** (migration **141** `customer_portal_tokens`): magic-link
  `/portal/customer/[token]` shows a customer their invoices/balance/statement and pays via the
  **existing `/pay` path**; admin mint/revoke on the customer drawer. Public route token-validated
  via admin client, every query narrowed to `org_id` + `customer_id`; middleware allowlists it.
- **Vendor self-service portal** (migration **142** `vendor_portal_tokens`): magic-link
  `/portal/vendor/[token]` uploads W-9 / COI / banking into the documents bucket as **PENDING**
  review (never auto-approves); admin request/revoke; type + size guarded; writes stamped from
  the token, never client ids.
- **1099-MISC + FIRE e-file** (no schema): mirrors the NEC path additively (NEC untouched),
  boxes 1/2/3/6/10 + fed/state withholding, thresholds, card→1099-K exclusion, Copy B PDF, FIRE
  file; transmission still needs a **TCC** (human).
- **ACH / wire origination rail** (migration **143** `payment_origination`): provider-agnostic
  `OriginationProvider` interface + **SANDBOX** adapter on top of the already-posted disbursement
  release; tracks batch/item lifecycle (CREATED→SUBMITTED→SETTLED/RETURNED) with ACH return codes;
  **posts NOTHING to the GL** (release already did); idempotent submit; gated on
  `ap_disbursement_release`.
- **Live sales-tax engine** (migration **144** extends `sales_tax_rates`): `TaxRateProvider`
  interface + internal-table provider resolving postal>city>county>state with effective-dating,
  wired into `resolve-invoice-tax` with a **SAFE fallback** (no regression); rate-table manager +
  CSV import; Avalara/TaxJar adapter scaffolded (credential swap). Tax-cents / GL math unchanged.
- **Direct-API migration connectors** (no schema): QBO/Xero/Sage provider registry + field-mapping
  profiles + credential-gated adapters + a **MOCK/fixture pull that feeds the existing
  historical-conversion pipeline** end-to-end (same preview + tie-out gate); real adapters degrade
  safe until OAuth creds land.

### External auditor + PBC, observability, perf, UX polish, reporting-basis overlay (`9c0ee28`, migrations 145–148)
- **External auditor access** (migration **145** `pbc_requests`): a view-only "External Auditor"
  role built on the **existing custom-role system** (no `permissions.ts` change), provable
  no-write profile, + a **PBC** (prepared-by-client) request list (request→assign→fulfill with
  doc→accept). Nav: `/pbc` under Firm & Governance.
- **Observability** (migration **146** `app_error_log`): `captureError → app_error_log`
  (secret-scrubbed) wired into **`api-handler`'s catch blocks**; global + client error boundaries;
  an ops health dashboard on the Operator Console; optional **Sentry** forwarding behind
  `SENTRY_DSN`.
- **Performance**: real **pagination caps** on `/api/invoices` + `/api/documents` (were
  unbounded) + a pure pagination helper; migration **148** (`perf_indexes`) adds composite indexes
  on the hot `gl_entries` / `bank_transactions` / `invoices` / `documents` list paths. Aggregates
  unchanged.
- **UX polish sweep**: a11y (role=dialog / aria-modal / Esc / focus), tabular-nums, responsive
  tables, labeled inputs, design tokens across the newly-built surfaces.
- **Reporting-basis overlay** (migration **147** `reporting_basis_adjustments`): a Basis toggle
  (Accrual GAAP | Tax | Cash | Custom) on P&L/BS/TB that **layers per-account adjustments on the
  GAAP output** (never posts to the GL — accrual stays the one book of record); tax basis derives
  from book-to-tax M-1; net-zero balance check; itemized/drillable; exports carry the basis. Nav:
  `/reports/basis-adjustments`. (Cash-basis auto-derivation + tie-out fixes followed in `e2702c5`.)

### INTEGRITY REMEDIATION — subledger↔GL tie-out + one-click cash/accrual + security mediums (`e2702c5`, migration 149)
Remediates a read-only tie-out + security audit. **All JEs still balance and post only through
`postJournalEntry`; accounts resolve by ROLE; idempotency via `source_ref` + migration-064 unique
index.** Migration **149** seeds `NOTES_PAYABLE` / `INTEREST_EXPENSE` role keys + revokes anon
grants on the portal-token tables.
- **AR (critical):** invoices that post to the GL now **debit AR_CONTROL (1100) by role** instead
  of a broken account-number **range that excluded 1100** (it was mis-posting to 12xx assets on
  estimate-conversion / recurring / agentic invoices). All 3 AR call sites unified on
  `resolveRole('AR_CONTROL')`; invoice-edit re-post preserves the deferred(2410) / sales-tax /
  retainage split. **`v_ar_aging` now ties to GL 1100.**
- **Leases:** post **DR ROU (1580) / CR lease liability (2550)** at commencement (was: subledger
  only).
- **Debt:** post **DR cash / CR notes payable (2500)** at origination; payments split
  principal vs **interest (8000)** by role (was: no opening entry, liability drifted negative).
  **Fails closed (422)** if the opening JE can't post — needs an open fiscal period + resolvable
  roles.
- **Rev-rec:** resolve **2410 / 1180 / revenue by role** (was hardcoded) + `source_ref`
  `rev_rec:<job>:<YM>` so concurrent runs can't double-post; documented non-interleave with the
  unbilled accrual.
- **Payroll:** wired `recordPayrollRemittance` into a gated **`/remit` route** + UI so tax/benefit
  payables actually clear (were open forever); idempotent per run.
- **Fixed assets:** reverse the GL post if the subledger insert fails (**no orphaned GL**);
  disposal idempotent via `source_ref`/064; prepaid-insurance GL tie-out surfaced.
- **Cash/accrual** (owner ask): the Basis toggle now does **CASH automatically / one-click**,
  reusing the existing proven accrual→cash conversion; Accrual stays default; flows to exports.
  Prominent **Accrual | Cash | Tax | Custom** segmented control.
- **Security mediums:** rate-limit the **3 public token endpoints** (429), payroll
  **releaser ≠ approver** SoD, **`gl/post` rejects empty org** (400), anon grants revoked on the
  portal-token tables.

> **An independent re-audit CONFIRMED all tie-out findings closed — the subledgers now tie to
> the GL by construction.** This is the session's material correctness milestone.

---

## 3. Data / infra changes (reproducibility notes)

**Migrations added THIS session and applied to Supabase (project `npqeijipggtuduhkejxq`)
first, then code committed** (canon migration rule):

| File | Commit | Purpose |
|---|---|---|
| `139_estimates.sql` | `2a36a0b` | Estimates/quotes + estimate lines (non-posting; convert-to-invoice). |
| `140_customer_deposits.sql` | `2a36a0b` | Customer deposits/retainers + applications (2420 subledger). |
| `141_customer_portal_tokens.sql` | `c8c3b22` | Magic-link customer self-service portal tokens. |
| `142_vendor_portal_tokens.sql` | `c8c3b22` | Magic-link vendor document-upload portal tokens. |
| `143_payment_origination.sql` | `c8c3b22` | ACH/wire origination batches + items (sandbox rail; posts nothing). |
| `144_sales_tax_rates.sql` | `c8c3b22` | Extend sales-tax rate table for the live rate engine (effective-dated). |
| `145_pbc_requests.sql` | `9c0ee28` | External-auditor PBC (prepared-by-client) request list. |
| `146_app_error_log.sql` | `9c0ee28` | Error observability log (secret-scrubbed) for api-handler + boundaries. |
| `147_reporting_basis_adjustments.sql` | `9c0ee28` | Per-account basis overlay adjustments (Accrual/Tax/Cash/Custom). |
| `148_perf_indexes.sql` | `9c0ee28` | Composite indexes on hot gl_entries/bank_transactions/invoices/documents paths. |
| `149_debt_role_keys_and_portal_grant_hardening.sql` | `e2702c5` | Seed NOTES_PAYABLE/INTEREST_EXPENSE role keys; revoke anon grants on portal-token tables. |

- **Highest Books migration file: `149`. Next free Books migration number: `150`.** (The Books
  band still has designed gaps — `134` skipped, `114–119`, `122–129` unused; the Projects band is
  `1xxx`.)
- **Two live Merit orgs (both named "Merit Management Group") — carried forward, unchanged:**
  - **`1d1aa1ef-4218-4187-a622-4a80da1a9e11`** — the **working seeded dev tenant** (3 locations),
    bound to the **DEV Clerk instance**; this is what production authenticates against today.
  - **`eb3d8087-7798-480d-9617-bdf73f63918a`** — the **empty parked live tenant** (1 location),
    bound to **prod Clerk**. Production cutover remains deferred (§4).
- **Working tree (left for the lead, not part of any committed slice):** modified
  `apps/web/.env.local.example` and `package-lock.json`; untracked `.claude/settings.local.json`
  and a `_to_delete/` scratch directory. None are shared-spine logic changes.
- **Vercel deploy:** auto-push loop → `next build` (authoritative typecheck). At time of writing,
  `origin/main == d2b438c` and the working tree is **ahead 3** (`c8c3b22`, `9c0ee28`, `e2702c5`);
  earlier commits are READY, the last three build once the loop pushes them — **verify READY.**

---

## 4. Open items — DO NOT FORGET

### KNOWN-OPEN launch blockers (carried forward — all human-only)

1. **Anthropic org is DISABLED / unfunded → ALL AI is operationally down.** Account-level, **not
   a code bug** — `ANTHROPIC_API_KEY` shows "This organization has been disabled." The app degrades
   gracefully everywhere; deterministic paths and the FP&A heuristic parser still work. This session
   added only deterministic depth + integrity fixes, so nothing regressed while AI is dark.
   **Fix = fund/re-enable the Anthropic account** (Mike), then re-verify a full drop-and-parse
   round-trip + NL/FP&A against live AI.
2. **Production is intentionally on the DEV Clerk instance.** Do **NOT** re-cut to prod until all
   are ready together: (a) a **separate prod Supabase project**, (b) prod-Clerk **Third-Party-Auth
   trust** repointed, (c) a **funded Anthropic key**, and (d) a **live-billing decision**. The prior
   failed attempt was a **crossed publishable/secret key** — double-check `pk_`/`sk_` pairing on the
   next cutover. Parked live tenant `eb3d8087-…`.
3. **Live tenant billing/charging via Stripe is NOT wired.** Operator Console MRR/ARR is
   **list-price computed only**. No charge button.
4. **Stripe is in TEST mode and Plaid in SANDBOX.** No real money moves in the current environment.
5. **Payroll provider unpicked** (Check vs Gusto, task #34). The **register-import → balanced JE**
   path (S49) is the **honest primary**; the mock run engine is an **estimate only**. Gates Payroll
   Phase B (releaser≠preparer — the SoD half now landed in `e2702c5` — double-post guard, live
   provider).
6. **Marketing-site honesty items** — reconcile claims to reality: **semantic search is Postgres
   FTS (GIN tsvector), NOT vector/embeddings** (semantic/embeddings search remains **deferred** —
   it needs an embedding provider and is non-functional with AI down); **1099 IRIS is NOT built** as
   a real IRS submission (this session added **1099-MISC + a FIRE file**, but FIRE transmission still
   needs a human **TCC**); **insurance now DOES post** (S48 migration 132; prepaid tie-out surfaced
   again in `e2702c5`).
7. **The paused hourly autonomous build task** remains paused — do not assume it is running.
8. **Standing pre-existing tsc / pglite test-harness failures are NOT regressions.** The known set —
   Stripe module types when the SDK/env is unbuilt in the sandbox (present on Vercel), `pglite` not
   installed so the migration-replay suites skip/error, a couple of test-file nits — predates this
   session. Baseline noise, not new breakage.

> **Note: branded invoice email already works — do NOT list email as a launch blocker.** (Rotating
> the Resend key + setting `INVOICE_FROM_EMAIL`/`INVOICE_FROM_EMAIL` remains a hygiene item under the
> identity residual, not a blocker.)

### Product gaps built to the credential boundary THIS session (each just needs its credential/provider to go live)
- **Customer + vendor portals** — magic-link routes are live; production hardening rides on the
  chosen link-delivery + review workflow.
- **ACH/wire origination rail** — SANDBOX adapter; needs a live originator (bank/processor)
  credential to move real money. Posts nothing to the GL (release already did).
- **Live sales-tax rate engine** — internal-table provider works today; Avalara/TaxJar adapter is
  scaffolded and needs API credentials.
- **1099-MISC + FIRE file** — generated; IRS transmission needs a **TCC**.
- **Direct-API migration connectors (QBO/Xero/Sage)** — MOCK/fixture pull feeds the real conversion
  pipeline end-to-end; real adapters need OAuth credentials.
- **External-auditor access + PBC** — role + workflow live on the custom-role system.

### Deferred-by-design (not gaps to "fix" blindly)
- **Semantic/embeddings search** is deferred — needs an embedding provider and is non-functional
  with AI down; `/search` stays Postgres FTS.
- **Full parallel-ledger multi-book** is deferred — the **reporting-basis overlay** (Accrual|Tax|
  Cash|Custom, non-posting layer on the one GAAP book) is the **safe version shipped** this session.

### Follow-ups worth noting (minor, non-blocking)
- **Debt origination now FAILS CLOSED (422)** if the opening JE can't post — it needs an **open
  fiscal period + resolvable roles**. Expected behavior; surface a clear operator message.
- **The basis-adjustments manager still allows manual CASH rows** the one-click toggle now ignores
  (the toggle derives cash automatically) — minor cleanup.
- **Role-based sidebar shows-all for custom roles** (fail-safe), so an external auditor sees links
  their page-guards then block — a UX-polish follow-up (page-guards remain the enforcement boundary).
- **A DB-backed rate limiter** — the public-token limiter added in `e2702c5` is **per-instance
  in-memory**; move to a shared store if cross-instance throttling is wanted.

### Carried-forward identity / RBAC residual (from S45–S49 — still open)
- Org resolution is **CLOSED live** (Clerk native `o.id` claim + auto-bind; page-guard
  single-membership + `get_org_id` single-active-seat fallbacks are additive/fail-closed).
  **MANUAL for Mike:** stand up the **Clerk production instance for `app.meritbooks.app` + `org_id`
  claim** (retires the fallbacks), add `app.meritbooks.app` to the **`meritbooks-web`** Vercel
  project, set **`NEXT_PUBLIC_APP_URL`** + **`EVENT_WORKER_SECRET`**, rotate the **Resend key**.
  ⚠️ The marketing site is a SEPARATE Vercel project (`meritbooks-marketing`) — apex `meritbooks.app`
  stays with marketing; the app gets `app.` only. **Claude-side residual:** `core.assignments`,
  event-worker read/"peek" scoping, location-scoped RLS, control/`team_performance` permissions.

### Other standing opens
- Master-Doc amendments awaiting Mike's ratification (task #19).
- Browser-verify the newest pages (task #18) — the S50 surfaces (estimates→invoice, deposits,
  borrowing base, portals, ACH origination, sales-tax rates, 1099-MISC, PBC/auditor, basis overlay,
  cash/accrual toggle) have **not** been Chrome-audited yet.
- New security seam from S49 still worth a confirming review: the reconciliation-history route uses
  the admin client to resolve finalizer display names (org-scoped, no cross-tenant exposure).

---

## 5. Direction — what's next

1. **Fund/re-enable the Anthropic account** to bring the whole AI surface back online, then
   re-verify a full drop-and-parse round-trip and the NL/FP&A paths against live AI.
2. **Make a live-billing decision**, then (if go) wire real Stripe subscription charging so the
   Operator Console MRR is realized, not list-price computed.
3. **Prepare (do not execute) the real production cutover** — dedicated prod Supabase project,
   prod-Clerk Third-Party-Auth trust, funded Anthropic key, scripted env swap with a pk/sk pairing
   check so the crossed-key failure cannot recur.
4. **Take the credential-boundary builds live one credential at a time** — a live ACH originator,
   Avalara/TaxJar keys, 1099 FIRE TCC, ERP OAuth — each flips a shipped, tested surface from sandbox
   to real.
5. **Chrome-audit the S50 depth** on the deployed dev-Clerk app (estimates→invoice, deposits,
   borrowing base, portals, origination, sales-tax rates, 1099-MISC, PBC/auditor, basis + cash/accrual
   toggle, rebuilt manager KPIs).
6. **Pick the payroll provider** to unblock Phase B (releaser≠preparer SoD is now in place); keep
   driving Invoices / Reports / Bank-Rec / Reconciliation to **Complete** behind their FPBs.

---

## 6. Agents

Eight defined agents in `.claude/agents/` (builder, verifier, auditor, reviewer, designer, scribe,
security, chrome-auditor) + SDK agents (general-purpose, Explore, Plan). **All on opus 4.8**
(CLAUDE.md §0.1 binding). Parallel builder/general-purpose agents on file-disjoint slices, 3–5
concurrent, one verification lane through the lead. Reserved shared spine (migrations,
`packages/shared`, `api-handler.ts`, `navigation.ts`, `rbac/permissions.ts`) is single-threaded
through the lead.

## 7. Live state

- **Repo HEAD:** `e2702c5` on `main`. **`origin/main` is `d2b438c` — working tree ahead 3**
  (`c8c3b22`, `9c0ee28`, `e2702c5` await the auto-push loop). Auto-push ships to Vercel; `next
  build` is the authoritative typecheck. Earlier commits READY; the last three build once pushed —
  **verify READY.**
- **Auth:** production runs on the **DEV Clerk instance** (deliberate — see §4).
- **Supabase:** project `npqeijipggtuduhkejxq`; migrations through **149** applied this session
  (139–149 new); next Books number **150**.
- **Working tenant:** `1d1aa1ef-…` (seeded, 3 locations, dev Clerk). Parked live tenant:
  `eb3d8087-…` (1 location, prod Clerk).
- **AI:** Anthropic account **disabled/unfunded** — ALL AI seams operationally down; app degrades
  gracefully. This session added only deterministic depth + integrity fixes. Plumbing/grants correct.
- **Money rails:** Stripe **TEST** mode, Plaid **SANDBOX**; ACH origination **SANDBOX**; live tenant
  billing NOT wired.
- **Integrity:** subledgers (AR/2420 deposits/leases/debt/rev-rec/payroll/fixed-assets) now **tie to
  the GL by construction** — confirmed by an independent re-audit this session.
- **Known non-regression noise:** Stripe / pglite / tenant-isolation / schema-contract type-harness
  failures (baseline).

## 8. One-line for the next session

A product-breadth-then-integrity session while AI stays dark: shipped the last credential-boundary
gaps (estimates→invoice + deposits [mig 139/140], customer + vendor portals [141/142], ACH
origination rail [143], live sales-tax engine [144], 1099-MISC + FIRE, direct-API ERP connectors,
external-auditor + PBC [145], error observability [146], reporting-basis overlay [147], perf indexes
[148]) — then did the important one: a subledger-to-GL **tie-out remediation** ([149]) that fixed AR
mis-posting off 1100, added lease/debt opening JEs, role-resolved rev-rec, payroll remittance, and
fixed-asset orphan/idempotency, plus one-click cash/accrual and four security mediums — **confirmed
closed by an independent re-audit.** HEAD `e2702c5` (working tree ahead 3, auto-push shipping); next
free migration **150**; next: **fund Anthropic, decide live billing, prep a clean prod cutover, take
the credential-boundary builds live, and Chrome-audit the new depth.**
