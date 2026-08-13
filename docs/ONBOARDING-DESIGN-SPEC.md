# AI-Native Onboarding — Design Spec (synthesized from the expert panel)

Owner mandate: **the world's easiest, most helpful, most accurate onboarding for a new
ERP. Ease of use is the selling point.** Synthesizes four advisory briefs (senior
controller, product/UX, AI engineer, software architect). Companion to
`docs/REV-REC-WIP-SPEC.md`.

## 1. The thesis — "review, don't enter; connect, don't configure"

The first thing onboarding asks is not a field, it's a **source**: "Where do your books
live today?" → QuickBooks / Xero / Sage / drop files / start fresh. We ingest and MeritBooks
**arrives at a proposed, already-populated book of record**; the human **confirms** rather
than enters. The emotional payoff no incumbent delivers: after opening balances post, one
line — **"Balanced to the penny ✓"** — turns "I hope I set this up right" into "it's *proven*
right." Target: a real, tied-out financial picture in **under 5 minutes** from connect.

## 2. Two flows, routed server-side by COMPANY state (never self-selected)

- **New company (not set up)** → **Full guided setup.** Whoever does the inaugural login runs
  it — admin OR delegated staff (routing is company-state, not role).
- **Existing/live company + newly-added user** → **60-second, role-aware TOUR**, never a setup
  surface. Welcome by name + role, 3–5 spotlight stops on real nav, one genuine first action,
  always skippable/resumable.
- Resume mid-flight at the first unfinished section; a new member with onboarding-owner scope
  on an unfinished company resumes setup (not restart). Fail-safe: unresolved org → treated as
  complete so no one is ever trapped.

## 3. Critical path vs. the long tail (ease of use = hide almost everything)

**Only three things gate "ready to operate":** (1) a company exists (from the connect/import),
(2) opening balances post and **tie out**, (3) accrual/cash + rev-rec method chosen
(auto-selected from industry — Artistry = accrual, % of costs incurred — one confirm).

Everything else — AR/AP, jobs/WIP, debt, equity, leases, fixed assets, tax, team, policies —
lives on an optional **"Setup Home" board**, never as gates, each domain a card in one of:
**Done ✓ / Detected–needs a look / Add later (neutral, never a red nag)**. Each leans on
**drop-and-parse**: "Have debt? Drop the loan doc." "Leases? Drop the PDF." Skipping files the
item on the board (nothing lost). A non-job business on POINT_OF_SALE never sees the WIP lane;
a contractor on PCT_COSTS_INCURRED gets it — driven off the rev-rec method chosen in step 1.

Readiness reframed from "steps remaining" to **"Books health"**: a "Ready to operate" tier
(the 3 criticals, celebrated at 100%) + a gentle always-optional "Fully set up" tier. Optional
domains are neutral grey ("not used"), never a warning.

## 4. Construction gating (controller brief — the accuracy that earns trust)

For a homebuilder the WIP/job layer is a **first-class gating domain**, not "later." Day-one
required per open job: contract value + change orders, **budget/EAC by cost code**,
costs-to-date, billed-to-date, retainage (receivable & payable), customer deposits (liability,
never revenue). Deferrable: completed jobs, full GL history, backlog analytics.

**Extended tie-out gate (all hard blocks before go-live):** TB debits=credits; balance-sheet
identity; **subledger→control ties** (Σ open AR = 1100, Σ open AP = AP control, retainage each
side); **WIP→GL ties** (Σ costs-to-date = WIP asset, Σ unbilled = 1180, Σ billings-in-excess =
2410). Construction control accounts (1180, 2410, retainage rec/pay, customer deposits, WIP)
must exist + be role-mapped in the COA gate *before* opening balances.

**Mid-year vs. fiscal-boundary:** default to year-end (clean); if mid-year, force the explicit
choice and default to **importing YTD activity** so YTD P&L matches QuickBooks during the
parallel run, and **HARD_CLOSE all pre-conversion periods**. Migration guardrails: load AR/AP
once as detail then derive the control (never double-count); retainage/deposits never folded
into trade AR/revenue; attest the EAC is current; validate normal-balance signs.

**Final artifact: a "Conversion Reconciliation" report** — opening BS, AR aging, AP aging, WIP
schedule, each MeritBooks vs. source with a variance column that must be zero. This is what the
accountant holds next to QuickBooks during the parallel month.

## 5. AI seam — proposes facts, deterministic + human dispose (degrade-safe)

Invariant (already encoded in `lib/onboarding/mapping-ai.ts` + `conversion.ts`): **AI proposes
a mapping/classification/extracted field; it never authors a dollar or a posting; deterministic
math + human approval dispose; the DB `check_journal_balance()` trigger is the final backstop.**

Every proposal is data of shape `{ value, confidence, source:'ai'|'heuristic'|'human'|'unmapped',
reasoning }`. Thresholds: ≥0.90 pre-filled/collapsed (bulk-acceptable); 0.60–0.89 pre-filled +
flagged; <0.60/null left blank (never guessed). Nothing that hits the GL auto-posts — opening
JE, debt schedule, lease entries stay propose-and-approve + tie-out-gated.

**Degrade-safe (AI is OFF today):** each step is `deterministic-first`, AI in an
`if(apiKey){try…}catch(isAiUnavailableError)` wrapper; fallbacks = connector pull / CSV
column-map / manual entry; the tie-out gate holds regardless. Re-enabling the key is a pure
quality lift (more fields pre-filled at higher confidence) with **zero schema/flow change** —
because AI writes the same proposal shape the human otherwise fills. Ranked AI leverage:
COA→account+ROLE mapping (#1), industry→rev-rec inference, opening-balance mapping, then
drop-and-parse extraction for jobs/WIP, debt+covenants, leases, assets, bank, equity, W-9/COI —
all reusing parsers that already exist (`lib/debt/parse-loan`, `lib/leases/parse-lease`,
`lib/bank/statement-parse`, `lib/fixed-assets/asset-parse`, `lib/vendors/{w9,coi}-parse`, …).

## 6. Architecture — pluggable section framework on the existing pipeline

The conversion pipeline is already the reference contract (source → proposal → review →
tie-out gate → deterministic commit). Lift it into a `SectionDefinition` interface so every
domain is a self-describing, file-disjoint module the shell renders generically:

```
interface SectionDefinition { key; label; icon; tone:'required'|'recommended'|'optional';
  domainKind; importSources:('erp'|'document'|'csv'|'manual')[]; skippable; notApplicable?;
  deriveStatus(status)->'not_started'|'in_progress'|'done'|'skipped'|'n_a';
  propose(ctx); validate(proposal)->{blockers}; commit(ctx,proposal); ReviewComponent }
```

- **State:** company-state router (outer) + per-section status map (inner) persisted in the
  existing `core.organizations.onboarding_state` jsonb (already applied — widen the shape only,
  no DDL) via the existing `/api/onboarding/status`. Derived `done` (live counts) always wins
  over stale stored state. "Go-live-ready" = every `required` section `done`.
- **Proposals** stage in `public.ai_decisions.proposed_output` with a per-domain `kind` (the
  conversion session pattern generalized) — no new proposal table.
- **Commit** always through `postJournalEntry` (roles via `account-roles.ts`), tie-out-gated,
  `source_ref`-idempotent.
- **Reuse, don't rebuild:** conversion pipeline, drop-and-parse family, ERP connectors +
  `conversion-adapter`, entity-create/COA-seed. Net-new is a shell + section framework, not a
  rewrite. Six shared components (SourceTile, ProposalCard, TieOutBanner, DropZone empty state,
  SetupHome card, ReadinessCard) make every domain feel identical.

## 7. Build slice plan (file-disjoint waves; reserved spine untouched)

- **Wave 0 (foundation, serialized):** widen `onboarding_state` shape + `status.ts` normalizer
  + `PATCH /api/onboarding/status` `{section,status}`; define `SectionDefinition` + registry +
  generic shell; refactor the existing company/coa/opening/bank/team steps to conform with
  **zero behavior change** (proves the interface; conversion tests stay green).
- **Wave 1 (parallel, one section per builder):** company+COA · bank+team · customers/AR +
  vendors/AP · debt+leases+fixed-assets · jobs/WIP+tax+policies — each a new file per section +
  its ReviewComponent, all on the same propose/validate/commit contract.
- **Wave 2:** generalize the proposal store (kind-keyed) + a shared `proposeVia` helper; build
  the guided-tour flow for new users into a live tenant.
- **Verification each wave:** `next build` typecheck (fails closed), Vitest (conversion/mapping/
  schema guards + a validate() + balanced-commit test per committing section), then verifier +
  chrome-auditor on deployed `/onboarding`; security for any money-movement section.

Copy tone throughout: calm, first-person-plural ("we found…"), plain-language primary +
accountant-precise secondary, verbs not nouns, never scold. Full keyboard, no dead-ends,
reduced-motion respected, confidence conveyed by text not color alone.
