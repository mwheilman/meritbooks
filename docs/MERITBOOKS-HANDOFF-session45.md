# MeritBooks — Session 45 Handoff

**Date:** 2026-08-02
**Supersedes:** session 44. Use this as the current source of truth for build state.
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

The session that **closed identity gate #9 live** and **added the accounting-close /
controls / tax / workflow spine** that turns the deep-but-scattered segments of Session 44
into a governed month-end system. Session 44 opened the last AI modality and drove the thin
segments to depth; Session 45 (a) **proved multi-tenant org resolution closed live** —
tenant resolved from the Clerk native `o.id` org claim with auto-bind and the first-org
fallbacks removed, (b) shipped the **FP&A dashboard, direct-method cash-flow + forecast,
close orchestration graph, and a generalized AP policy engine**, (c) stood up the
**Document Management Center + polymorphic attachments** (with a **private `documents`
Supabase storage bucket**) and mounted the **AttachmentsPanel on bill / invoice / lease /
debt / fixed-asset / journal-entry** detail views, (d) built the **Controls / SOX
command center**, the ranked **Action Inbox**, **configurable N-step approval workflows**,
and **recurring journal-entry templates** with per-period propose→approve→post, (e) shipped
the **ASC 740 income-tax provision** (current + deferred from book-to-tax differences) and a
read-only **1120-style Tax Return Package** aggregator with PDF export, and (f) **completed
the account-role registry** — income-tax / lease / prepaid / intangible / disposal roles,
resolving provision + prepaid by role with number fallback — plus a **defense-in-depth
security fix** routing the approval-workflow tables through the RLS-scoped client.

Everything below is on `main`. **Production HEAD is `942d702`** (`security(approvals): route
workflow tables through RLS-scoped client`); every Books wave commit built on the auto-push →
Vercel `next build` loop (the authoritative full-project typecheck). Books migrations
**090–094** were applied to Supabase first, then the dependent code committed.

---

## 2. What shipped this session (Books)

### Identity gate #9 — CLOSED live

- **Multi-tenant org resolution proven closed** (`15be345`, `1dc8b8d`): tenant is resolved
  **claim-first** from the Clerk **native `o.id` org claim** (the custom `org_id` claim comes
  back null on the dev instance, so `resolveOrgId` reads `o.id`), with **auto-bind on login**
  and the **first-org fallbacks removed** from require-permission / page-guard / payments /
  event routes. `get_org_id` in migration `087` matches the same claim path. The residual on
  gate #9 is now the **MANUAL-for-Mike** production work (Clerk prod instance + DNS + claim)
  and the Claude-side per-route money-permission split (task #56).

### Accounting-close & controls spine

- **FP&A dashboard** (`40125d6`) — read-only KPIs, variance-to-plan, runway & trends; plus
  **best/base/worst what-if + one-driver sensitivity** on the driver budget (`cd66b45`).
- **Direct-method cash-flow statement + driver-based cash forecast** (`884bf5f`).
- **Close orchestration** (`56a91d3`) — an ordered close task graph with **live auto-verify**
  and a **blocking hard-close gate**.
- **AP policy engine generalized** (`8f0456b`) — the policy engine is now a reusable primitive
  applied to AP bill-approval; **expense-policy AI compiler + deterministic enforcement**
  (`034c428`) shipped alongside.
- **Controls / SOX command center** (`cbb4990`) — read-only compliance command center.
- **Action Inbox** (`5b8c558`) — a **ranked, read-only** unified queue aggregating approvals,
  blocks, alerts, exceptions, and drafts.
- **Configurable approval workflows** (`7eee2fb`, migration 092) — N-step approval chains by
  **doc type + amount tier**.
- **Recurring journal entries** (`e0da45c`, migration 093) — recurring JE templates with
  **per-period propose→approve→post** (standard accruals); nav added for Recurring Entries.

### Documents & attachments

- **Document Management Center + polymorphic attachments** (`2f56793`, migration 090) — plus a
  **private `documents` Supabase storage bucket** created this session (`e49e97e`). This
  addresses the standing "no storage bucket" drift item — the bucket now **EXISTS**.
- **AttachmentsPanel mounted** (`3bae464`) on **bill / invoice / lease / debt / fixed-asset /
  journal-entry** detail views.

### Tax

- **ASC 740 income-tax provision** (`ab83895`, migration 091) — current + deferred tax computed
  from the **book-to-tax differences** (feeds off the Session-44 M-1/M-3 tagging).
- **Tax Return Package** (`fee450b`) — a **read-only 1120-style** aggregator + API + page with
  **PDF export**.

### Account-role registry completion + security

- **Account-role registry completed** (`e588e0d`, seed migration 094) — added **income-tax /
  lease / prepaid / intangible** roles (and disposal roles); the provision and prepaid engines
  now **resolve accounts by role with a number fallback**, honoring the canon "reference by
  role, not hard-coded number" invariant. Migration 094 seeds the tax/prepaid/intangible
  account-role vocabulary + accounts.
- **Security (defense in depth)** (`942d702`) — the approval-workflow tables are routed through
  the **RLS-scoped client** (was the admin client), closing an org-isolation gap on the new
  workflow routes.

### Nav

- Nav gained: **FP&A Dashboard, AP Policy** (`f2b8058`); **Action Inbox, Controls/SOX,
  Documents** (`e49e97e`); **Recurring Entries, Tax Provision** (`e0da45c`); **Fixed Assets,
  Tax Return Package, Approval Workflows** (`fcdbada`).

---

## 3. Data / infra changes (reproducibility notes)

- **Books migrations applied to Supabase this session (Supabase first, then code):**
  - `090_documents.sql` — document center tables + polymorphic attachments (RLS). The private
    **`documents` storage bucket** was created alongside it.
  - `091_tax_provision.sql` — ASC 740 income-tax provision (current + deferred).
  - `092_approval_workflows.sql` — configurable N-step approval chains by doc type + amount tier.
  - `093_recurring_journal_entries.sql` — recurring JE templates + per-period runs.
  - `094_tax_lease_prepaid_account_roles_seed.sql` — seeds tax/prepaid/intangible account-role
    vocabulary + accounts (completes the account-role registry).
- Prior Books migrations remain applied; the sequence still **skips `072`**. Projects `1001–1006`
  are owned by the MeritProjects workstream — Books does not own them.
- **Vercel `next build` is the authoritative full-project typecheck.** The wave verifier
  reported **0 new typecheck errors** and **71/71 new unit tests passing**: recurring-je (37),
  tax provision (13), approval workflow (21).
- The standing pre-existing harness failures are **unchanged and NOT regressions:** the PGlite
  migration-replay harness fails when pglite isn't installed in the sandbox, and
  `src/test/tenant-isolation.test.ts` has a parse error — both predate session 42.
- **Key ids unchanged:** org `1d1aa1ef-4218-4187-a622-4a80da1a9e11`; Supabase project
  `npqeijipggtuduhkejxq`; Clerk user `user_3BwDOygB7TuYWcrUUt87GOVvQV1`; Vercel team
  `team_2EwoHwR0BcH6GNjMjCbMaVAW`, project `meritbooks-web`.
- **Auto-push loop still live** on Mike's machine (ships `main` commits automatically). Claude
  cannot push from the sandbox and must not handle a token.

### Legacy duplicates found this session (do NOT delete — flagged for future cleanup)

- **`/recurring`** — superseded by **`/recurring-journal-entries`** (this session's build).
- **`/invoices/collections`** — superseded by **`/collections`**.
- Both still exist on disk. Leave in place until a deliberate cleanup slice; do not delete now.

---

## 4. Open items — DO NOT FORGET

### This session's follow-ups
- [ ] **Browser-verify the new verticals (task #18)** — chrome-auditor pass over the newly-live
      pages (documents/attachments, controls, action inbox, approval workflows, recurring JEs,
      tax provision, tax return package) on the deployed app.
- [ ] **Verifier concerns (task #52)** — remaining direct-key reads + the `/api/accounts` org
      filter noted by the verifier; confirm all closed.
- [ ] **Legacy duplicate cleanup** — remove `/recurring` and `/invoices/collections` once their
      successors (`/recurring-journal-entries`, `/collections`) are confirmed the sole path.

### Still-open gates
- [ ] **Identity gate #9 — MANUAL residual** (org resolution is DONE & live this session): stand
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
      AP intake queue built and Azure-ready).

### Known drift / deferred (carried forward)
- [ ] **Invoices to Complete (task #22)** — invoice write-off still needs a `BAD_DEBT_EXPENSE`
      account role + `v_ar_aging` to exclude `WRITTEN_OFF`.
- [ ] **Drop-and-parse follow-ups (task #71)** — small schema tidy-ups. **The `documents`
      storage bucket now EXISTS** (created this session), so the "no bucket" blocker is cleared;
      remaining is wiring the last parse paths' file persistence onto it.
- [ ] `api/vendors/route.ts` references `core.vendors` columns not on the live table — that path errors.
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

Per the canon gate order and `NORTH-STAR.md` (autonomous engine + supervision/trust layer;
depth-first, one pipeline per parallel wave, behind an FPB):

1. **Land the MANUAL gate-#9 productionization** — Clerk prod instance for `app.meritbooks.app`
   (+ DNS, redirect URLs, `org_id` claim), `EVENT_WORKER_SECRET`, Resend key — then the
   Claude-side per-route money-permission split (task #56), `core.assignments`, event-worker
   read-scoping, and location-scoped RLS.
2. **Browser-verify + polish the newly-live close/controls/tax spine** (task #18) — documents +
   attachments, controls/SOX, action inbox, approval workflows, recurring JEs, tax provision,
   tax return package — against their follow-ups; clear verifier concerns (task #52).
3. **Drive Invoices to Complete (task #22)** — write-off account role + `v_ar_aging` exclusion —
   and continue Reports / Bank-Rec toward Complete behind their FPBs.
4. **Payroll Phase B** once the provider is picked (releaser ≠ preparer, double-post guard, live Check).
5. **Extend the control library toward EC-1..EC-13** and let the M10 autonomy plane govern more
   dispositions; **grow the M14 learning column** beyond vendor-memory.

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
ran concurrent `general-purpose`/builder waves on disjoint slices (FP&A dashboard / cash-flow /
close-orchestration / AP-policy / documents+attachments / controls / action-inbox / approval-
workflows / recurring-JEs / tax-provision / tax-return-package / account-role registry), with
the identity, money, and workflow-authz seams reviewed by **security** (the approval-workflow
RLS routing fix, `942d702`) and the pure engines checked by **verifier** (0 new typecheck
errors; 71/71 new unit tests).

---

## 7. Live state

- **Production HEAD: `main` @ `942d702`** (`security(approvals): route workflow tables through
  RLS-scoped client`). Every Books wave commit this session shipped via the auto-push → Vercel
  `next build` loop (the authoritative full-project typecheck).
- Books migrations applied to Supabase this session: **090–094** (documents, tax_provision,
  approval_workflows, recurring_journal_entries, account-role seed). The sequence still skips `072`.
  A private **`documents` storage bucket** was created this session.
- **Identity gate #9 org resolution is CLOSED live** — tenant resolved from the Clerk native
  `o.id` claim with auto-bind, first-org fallbacks removed. Residual is the MANUAL Clerk-prod work.
- Clerk↔Supabase active on the **dev** Clerk instance; auto-push loop running on Mike's machine.
- **Verification:** the new deterministic-engine suites pass (recurring-je 37, tax provision 13,
  approval workflow 21 = 71/71) with 0 new typecheck errors, on top of the session-44 baseline.
  **Standing pre-existing harness failures — NOT regressions:** pglite not installed in the
  sandbox; `src/test/tenant-isolation.test.ts` parse error. Both predate this session.

---

## 8. One-line for the next session

Start by reading `docs/canon/CANON-ANCHOR.md` then this file. Session 45 **closed identity gate
#9 org resolution live** (Clerk native `o.id` claim + auto-bind, fallbacks removed) and shipped
the **month-end close / controls / tax / workflow spine**: FP&A dashboard, direct cash-flow +
forecast, close orchestration, generalized AP policy, **Document Center + attachments (with a
private `documents` bucket)**, Controls/SOX, ranked Action Inbox, configurable approval
workflows (092), recurring JEs (093), **ASC 740 tax provision (091)**, a read-only 1120-style
Tax Return Package, and a **completed account-role registry** (094) — plus a defense-in-depth
RLS fix on the approval routes. **Next:** the MANUAL Clerk-prod productionization for
`app.meritbooks.app` (DNS + `org_id` claim + `EVENT_WORKER_SECRET` + Resend key), browser-verify
the new verticals (task #18), split money permissions per route (task #56), drive Invoices to
Complete (task #22), and Payroll Phase B on provider pick — spec-first, disjoint parallel slices,
migrations-first, path-scoped commits alongside MeritProjects. **Do NOT touch the separate
`meritbooks-marketing` Vercel project; apex stays with marketing, app gets `app.` only.**
