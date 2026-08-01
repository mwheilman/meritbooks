# Feature Product Brief — Bank Reconciliation

**Module:** Bank Reconciliation (Books, Module 1 of 12) — **GATE 8**
**Author:** Auditor (Rule 13 FPB authorship)
**Date:** 2026-08-01 (Session 40 canon)
**Status of module today:** Functional — partial (Feature Completeness Ledger, Master Doc Part V.0). ZERO modules are Complete.
**Completion standard (Rule 13):** "Complete" ≠ renders/works/real-data. That is the *functional minimum*. Complete = **meets every dimension of this approved brief**, benchmarked against QBO/Sage bank rec with named deltas closed or explicitly deferred with reason, and every acceptance criterion below passing.

**Gate dependencies:** GATE 8 (remaining modules incl. AI cash application). Consumes GATE 12.0 (Plaid bank feed, DONE — the feed is live) and GATE 2 (posting engine, DONE). The session-40 **Reconciliation Autopilot** was built ungated/without an FPB (CANON-ANCHOR §7); this brief reconciles it to the canon and folds it into the module definition rather than treating it as complete.

---

## §0. Scope, grounding, and canon reconciliation

**What this module owns (canon-bound):**
- Reconciliation proves the **book (GL cash) equals the bank** at a period end. It **owns no money movement** — accepting a match here never posts to the GL; clearing to the book stays the job of the bank-feed approve/posting path (`autopilot/match/route.ts` is explicit about this, and it is correct).
- **Master data in `core`, ledger in `public`; no PostgREST embeds across `core`↔`public`** — stitch `core.locations`/`core.vendors` in JS via `fetchCoreMap` (CANON-ANCHOR §2; the recon route documents the Session-25 fix).
- **Matching uses the FROZEN composite score: Vendor 40% + Amount 40% + Date 20%** (CLAUDE.md Business Rules; `lib/services/reconciliation-match.ts` centralizes the weights so they can't drift), fed through the shared trust engine (`scoreToTier` → auto / review / escalate).
- **AI proposes; a human approves; audit everything.** The autopilot proposes matches; a human accepts/rejects; every AI proposal + human decision is written to `core.action_log` via the trust layer. AI never posts GL, never clears money (CANON-ANCHOR §3).
- RLS `org_id = get_org_id()` on `bank_reconciliations`, `bank_transactions`, etc.; reconciliation routes use `requireAuthedContext()` + the **RLS-scoped client** (correct — the reference other modules should follow).
- **Never re-expense a settlement.** A bank line that settles an open bill clears AP (DR AP / CR Cash), it does not re-book an expense — the autopilot pre-wires this by staging `matched_bill_id` + `match_type='BILL_PAYMENT'` for the approve path to read (CANON-ANCHOR §3).
- **Respect period status** (`fiscal_periods` OPEN / SOFT_CLOSE / HARD_CLOSE) — you cannot reconcile into a hard-closed period (the modal already filters out HARD_CLOSE).
- All money is **bigint cents**.

**The two surfaces today (both under `/reconciliation`, `reconciliation-tabs.tsx`):**
1. **Statement Reconciliation** (`reconciliation-view.tsx` + `reconciliation-modal.tsx` + `/api/reconciliation`) — the classic controller flow: enter statement ending balance + outstanding deposits/checks, the server computes GL cash as-of period end, and `difference = GL − adjusted`. `is_reconciled` when difference is zero.
2. **Reconciliation Autopilot** (session 40; `reconciliation-autopilot.tsx` + `/api/reconciliation/autopilot` + `.../autopilot/match`) — per-account/period, splits statement lines into **cleared** (POSTED + `gl_entry_id`) vs **uncleared**, proposes the best match per uncleared line (open bill or learned vendor pattern) with the composite score + tier, and lets a human accept (stage the match) or reject (flag to `/exceptions`).

**Out of scope here (separate briefs):** the Plaid bank feed itself (GATE 12.0, DONE) and bank-feed categorization/approval (the posting side); AI **cash application** to AR invoices (GATE 8, referenced in Dimension 7/14 as the receipts-side analogue but specified in the Invoices FPB Dimension 14).

**Retired — do not touch:** none relevant.

---

## §1. Sixteen-dimension brief

Each dimension states: **Purpose · What best-in-class does · Current MeritBooks state (built / partial / missing, cited to real files) · Named deltas · Testable acceptance criteria.**

---

### Dimension 1 — Data captured (the reconciliation record + the statement)

**Purpose:** Capture what a reconciliation is: a bank account, a period, the bank's ending balance, the outstanding in-transit items, the computed book balance, and the resolved difference — an immutable record once finalized.

**Current state — BUILT (partial):**
- `bank_reconciliations` (migration 007): `bank_account_id`, `fiscal_period_id`, `statement_ending_balance_cents`, `gl_balance_cents`, `outstanding_deposits_cents`, `outstanding_checks_cents`, `adjusted_bank_balance_cents` (**generated** = statement + deposits − checks), `difference_cents` (**generated** = gl − adjusted), `is_reconciled`, `reconciled_by`, `reconciled_at`, `statement_date`, timestamps. RLS `org_isolation`, `updated_at` trigger.
- `bank_transactions` (migration 005 + Plaid 046): `status`, `gl_entry_id`, `match_type` (CHECK: VENDOR_PATTERN / BILL_PAYMENT / RECEIPT / NONE), `matched_bill_id`, `match_confidence`, `ai_vendor_id`, `ai_confidence`, `ai_reasoning`, `final_vendor_id`, `amount_cents`, `transaction_date`, `description`.

**Named deltas / gaps:**
- **D1.1 — No per-line reconciliation linkage.** `bank_transactions` has **no `reconciled_at` and no `reconciliation_id`** (grep-confirmed: `reconciled_at` exists only on the `bank_reconciliations` header). "Cleared" is inferred at read time as `status='POSTED' && gl_entry_id`. There is no persisted record of *which reconciliation cleared which line*, so a reconciliation cannot be re-opened, audited line-by-line, or locked. **Flagged as a probable migration** (see Dimension 13).
- **D1.2 — Outstanding items are entered as lump sums**, not itemized. QBO/Sage track each outstanding check/deposit as a line that ages; here it's two integers, so you can't see *which* checks are stale/uncashed.
- **D1.3 — No beginning balance / prior-reconciliation link.** A reconciliation should start from the prior period's ending balance; the record has no `previous_reconciliation_id` and the flow doesn't carry the prior ending balance forward.
- **D1.4 — No statement metadata** (statement number, bank-reported beginning/ending, imported file reference).

**Acceptance criteria:**
- AC1.1 A reconciliation persists account, period, statement ending balance, itemized (or at least referenced) outstanding items, computed GL balance, difference, and — once finalized — `reconciled_at`/`reconciled_by`, immutably.
- AC1.2 Each `bank_transactions` line cleared in a reconciliation carries a `reconciliation_id` + `reconciled_at`, so the set of lines in a reconciliation is queryable and auditable.
- AC1.3 A new reconciliation defaults its beginning balance from the prior finalized reconciliation's ending balance and links to it.

---

### Dimension 2 — Statement import / entry

**Purpose:** Get the bank's truth into the app — via the live feed (Plaid) and via manual/file entry for accounts the feed doesn't cover.

**Current state — PARTIAL:**
- **Feed path (BUILT):** Plaid (GATE 12.0) populates `bank_transactions`; these lines ARE the statement in the autopilot model, matched against the book.
- **Manual path (PARTIAL):** the statement-rec modal captures **only** the statement ending balance + outstanding deposit/check totals (typed). There is **no import of statement lines** and **no manual line entry** for a non-Plaid account.

**Named deltas / gaps:**
- **D2.1 — No CSV/OFX/QFX statement import.** QBO/Sage import a downloaded statement file; MeritBooks has no file-import for statement lines (only Plaid feed or typed totals).
- **D2.2 — No manual bank-line entry** for accounts without a feed (cash accounts, accounts the bank doesn't connect via Plaid).
- **D2.3 — No statement-vs-feed reconciliation** — when Plaid is the source, there's no way to load the *official* statement and confirm the feed captured every line (feeds miss/duplicate; a controller reconciles to the paper statement).
- **D2.4 — No duplicate/gap detection** on imported lines.

**Acceptance criteria:**
- AC2.1 A tenant can import a statement via CSV/OFX/QFX into `bank_transactions` (or a statement-lines table), with duplicate detection against existing feed lines.
- AC2.2 A tenant can manually add bank lines for a non-feed account and reconcile it.
- AC2.3 The reconciliation confirms the statement ending balance against the sum of cleared lines + beginning balance, surfacing any gap.

---

### Dimension 3 — Matching engine (the composite scorer)

**Purpose:** Automatically propose which book item each bank line corresponds to, so the human only adjudicates the uncertain ones.

**Current state — BUILT (good):**
- `lib/services/reconciliation-match.ts` — pure, I/O-free, unit-testable; implements the FROZEN composite (Vendor 40% + Amount 40% + Date 20%) with `vendorSimilarity` (token containment + substring bonus), amount closeness, date closeness, and a human-readable explanation. Weights centralized in `MATCH_WEIGHTS`.
- `/api/reconciliation/autopilot` scores each uncleared **outflow** against open bills (APPROVED/PARTIALLY_PAID/PENDING, balance > 0), plus the AI/vendor pattern already on the row; picks the stronger candidate; runs it through `scoreToTier` (auto/review/escalate) using the tenant `getTierPolicy`.

**Named deltas / gaps:**
- **D3.1 — Inflows barely matched.** Only outflows are scored against bills. Inflows (customer receipts) get only the pre-existing pattern suggestion — there is **no matching of deposits to open AR invoices** (that's AI cash application, GATE 8; flagged here as the symmetric gap — Dimension 14).
- **D3.2 — No many-to-one / split matching.** A single deposit that covers several invoices, or one bank line splitting to multiple bills, isn't supported — QBO/Sage handle grouped deposits.
- **D3.3 — Candidate pool is bills only** — no matching a bank line to an existing *un-posted GL entry*, a transfer between the tenant's own accounts (inter-account transfer), or a prior manual JE.
- **D3.4 — No learning loop back from accept/reject** into the vendor-pattern model (the vendor-pattern-learning table 040 exists; confirm the recon accept feeds it).

**Acceptance criteria:**
- AC3.1 The composite scorer's weights and outputs are unit-tested (exact/near/off amounts; strong/weak vendor text; near/far dates) — extend the existing pure-function tests.
- AC3.2 Deposits are matched to open AR invoices (cash-application candidate), not only outflows to bills.
- AC3.3 Split matching: one bank line → multiple bills/invoices (and grouped deposit → one bank line) is supported and the amounts reconcile.
- AC3.4 Inter-account transfers are detected (matching offsetting lines across the tenant's own bank accounts) and proposed as a transfer, not an expense/income.

---

### Dimension 4 — Cleared / uncleared tracking (per line)

**Purpose:** The heart of reconciliation: mark each bank line cleared, watch the running difference collapse to zero.

**Current state — PARTIAL (derived, not persisted):**
- The autopilot **derives** cleared (`status='POSTED' && gl_entry_id`) vs uncleared per line and shows cleared count/amount, uncleared count/amount, and tier tallies. Cleared rows link to their `entry_number`.

**Named deltas / gaps:**
- **D4.1 — "Cleared" ≠ "reconciled."** Cleared here means "posted to the GL," which conflates *posting* with *reconciling to the statement*. In QBO/Sage a line can be posted-but-uncleared (outstanding) until it appears on the statement. Without a per-line reconciled flag (D1.1), the module can't represent "posted but not yet on the bank statement."
- **D4.2 — No interactive check-off.** The classic rec UX is a checklist: tick each statement line, a running "difference" ticks toward $0, finalize when it hits zero. The statement-rec modal has no line list at all (just totals); the autopilot lists lines but the "clearing" action is a match-accept, not a statement check-off.
- **D4.3 — No running-difference-to-zero UI** in the statement-rec flow (the modal shows an adjusted-balance preview, not a live cleared-vs-statement delta).

**Acceptance criteria:**
- AC4.1 A per-line reconciled/cleared state is persisted (Dimension 13) distinct from GL-posted state; the UI shows a check-off list with a running difference that reaches $0 when the reconciliation ties.
- AC4.2 A posted-but-not-yet-on-statement line shows as **outstanding**, not silently cleared.
- AC4.3 Cleared totals + beginning balance = statement ending balance is asserted before finalize.

---

### Dimension 5 — Reconciled completion (difference → 0, finalize & lock)

**Purpose:** Finishing a reconciliation is a formal, locking event that a controller and auditor rely on.

**Current state — PARTIAL:**
- `/api/reconciliation` POST computes GL cash server-side (never trusts the client), sets `is_reconciled = (difference === 0)`, and `adjusted`/`difference` are generated columns. The modal reports "Reconciled — GL ties exactly" or the residual difference.

**Named deltas / gaps:**
- **D5.1 — No explicit finalize/lock step.** `is_reconciled` is set at insert if the math happens to tie; there is no deliberate "Finalize reconciliation" action that stamps `reconciled_at`/`reconciled_by` and **locks the cleared lines** from further edit.
- **D5.2 — Can save a non-zero difference and walk away** with no forcing function to resolve it or create an adjustment (Dimension 6).
- **D5.3 — No re-open / undo** (Dimension 8).
- **D5.4 — `reconciled_by` is uuid** but Clerk ids are text (CANON-ANCHOR §2 attribution rule) — confirm human attribution goes to `core.action_log`, and `reconciled_by` is written null-or-core-uuid, never a Clerk text id.

**Acceptance criteria:**
- AC5.1 Finalizing requires difference = 0 (or an explicit posted adjustment that makes it 0 — Dimension 6); finalize stamps `reconciled_at`/`reconciled_by` (attributed correctly) and locks the reconciliation.
- AC5.2 A finalized reconciliation's cleared lines cannot be silently re-categorized/re-posted without an undo (Dimension 8).
- AC5.3 The completion event is written to `core.action_log`.

---

### Dimension 6 — Discrepancy & adjustment handling

**Purpose:** Reconciliations rarely tie on the first pass; the product must help *find* and *book* the difference (bank fees, interest, errors).

**Current state — MISSING:**
- The difference is computed and displayed; there is **no workflow to resolve it** — no "create adjusting entry" for a bank fee/interest, no discrepancy list, no "help me find the difference."

**Named deltas / gaps:**
- **D6.1 — No adjusting-entry path.** A bank fee or interest credit on the statement that isn't in the book should be bookable *from the reconciliation* (DR Bank Fees / CR Cash, or DR Cash / CR Interest Income) via `postJournalEntry` — balanced, respecting period lock. Missing.
- **D6.2 — No "find the difference" assist.** QBO surfaces likely culprits (a line off by the exact difference, a transposed amount). MeritBooks shows the number but no diagnosis.
- **D6.3 — No discrepancy log** — unmatched/rejected lines flag to `/exceptions` (good) but there's no reconciliation-scoped discrepancy summary.

**Acceptance criteria:**
- AC6.1 From a reconciliation with a non-zero difference, a user can create a balanced adjusting JE (bank fee/interest/error) that posts through the engine, respects the period lock, and reduces the difference toward zero.
- AC6.2 The reconciliation surfaces candidate causes of the difference (single line = difference, transposition, duplicate).
- AC6.3 Unresolved discrepancies are listed and routed to `/exceptions`, with the reconciliation showing its open-discrepancy count.

---

### Dimension 7 — Autopilot / automation (AI proposals + tiering)

**Purpose:** The AI pillar — the machine does the matching labor; staff supervise. This is where MeritBooks BEATS QBO.

**Current state — BUILT (unverified in browser, per task #18):**
- Per uncleared line: best-bill and pattern candidates, composite score, `scoreToTier` → auto/review/escalate with tenant policy; tier tallies in the summary. Accept stages the match (`matched_bill_id`/`match_type`/`final_vendor_id`); reject flags to `/exceptions`. **Full audit trail**: AI proposal (`actorType:'AI'`) + human decision both to `core.action_log` via `logAction`/`logHumanAction`. Never posts GL.

**Named deltas / gaps:**
- **D7.1 — "auto" tier does not actually auto-clear.** The tiering computes an `auto` count, but there is no path that auto-accepts high-confidence matches (with SoD + audit) — it's advisory only. Per the autonomy-dial model this is *correct by default* (auto-post OFF), but the per-tenant, per-task **autonomy dial** to enable auto-accept for the safest tier is not built.
- **D7.2 — No batch accept** ("accept all auto-tier") — a human must adjudicate one at a time.
- **D7.3 — Browser-unverified** (task #18) — the autopilot tab has not been confirmed with real data end-to-end.
- **D7.4 — No feedback into pattern learning** (ties D3.4).

**Acceptance criteria:**
- AC7.1 A per-tenant, per-task autonomy dial can enable auto-accept for the safest tier only, with SoD on the AI (the agent that proposes cannot also finalize the reconciliation) and full Decision-Log audit; OFF by default (CANON-ANCHOR §3, "never a global let-the-AI-run switch").
- AC7.2 Batch-accept of a tier is supported with a single audited action.
- AC7.3 The autopilot is chrome-auditor-verified with real data (task #18): matched/uncleared/tier counts are correct; accept stages the match; reject flags to `/exceptions`.
- AC7.4 Accept/reject decisions feed the vendor-pattern-learning model (040).

---

### Dimension 8 — Lifecycle, audit & undo / unreconcile

**Purpose:** A book of record must let you correct a reconciliation — with a full trail — never by silent mutation.

**Current state — PARTIAL:**
- Match accept/reject is audited to `core.action_log`. Statement-rec creation is a plain insert.

**Named deltas / gaps:**
- **D8.1 — No unreconcile / re-open.** Once created there is no supported way to undo a reconciliation, un-clear its lines, and try again (QBO's "Undo reconciliation" is standard). Without per-line linkage (D1.1) this is impossible today.
- **D8.2 — No reconciliation history detail.** The list shows header rows; there's no drill into *which lines* a reconciliation cleared, by whom, when.
- **D8.3 — No field-level audit on the reconciliation header** (edits to statement balance/outstanding aren't tracked in `audit_log`).

**Acceptance criteria:**
- AC8.1 An authorized user can unreconcile a finalized reconciliation: it un-clears its linked lines, reverses any adjusting entries (or blocks if the period is closed), and writes a full audit trail.
- AC8.2 A reconciliation drills to its cleared-line detail with attribution and timestamps.
- AC8.3 Header edits and finalize/undo are written to `audit_log` / `core.action_log`.

---

### Dimension 9 — Reconciliation reports & export

**Purpose:** The reconciliation report is the auditable artifact — proof the book tied to the bank at period end.

**Current state — MISSING:**
- No reconciliation report, no PDF/summary, no export. The UI shows a history table only.

**Named deltas / gaps:**
- **D9.1 — No reconciliation report** (beginning balance, cleared deposits/checks, ending balance, outstanding items, book balance, difference) — QBO/Sage generate a standard rec report PDF.
- **D9.2 — No export** (PDF/XLSX) of the reconciliation or its cleared/outstanding line lists.
- **D9.3 — No outstanding-items report** (the stale-check list that ages uncashed checks).

**Acceptance criteria:**
- AC9.1 Each finalized reconciliation produces a standard reconciliation report (branded PDF) matching the on-screen figures, listing cleared and outstanding items and the tie-out to book.
- AC9.2 The report and its line lists export to PDF and XLSX.
- AC9.3 An outstanding-items report ages uncashed checks / in-transit deposits across periods.

---

### Dimension 10 — Period-close gate integration

**Purpose:** A period should not close until its bank accounts are reconciled — that's the whole point of reconciliation in the close.

**Current state — PARTIAL / DISCONNECTED:**
- `fiscal_periods` carry OPEN/SOFT_CLOSE/HARD_CLOSE; `close_checklists` (007) drive a close checklist by phase; `/api/close` reports the grid and toggles checklist items. The reconciliation modal already refuses HARD_CLOSE periods.
- **But reconciliation is NOT a hard gate to close.** Nothing prevents a HARD_CLOSE while a bank account is unreconciled or shows a non-zero difference; the close checklist doesn't auto-verify reconciliation status.

**Named deltas / gaps:**
- **D10.1 — No enforced "all bank accounts reconciled" gate** before HARD_CLOSE. The close checklist has `is_auto_verified` items — a reconciliation-complete check should be one, auto-verified from `bank_reconciliations.is_reconciled` for the period.
- **D10.2 — No close-period reconciliation status roll-up** (per entity: X of Y accounts reconciled, difference outstanding).
- **D10.3 — Reconciling into a SOFT_CLOSE period** rules are unstated (the modal allows non-HARD_CLOSE; confirm SOFT_CLOSE reconciliation is intended and any adjusting entries respect the soft-close policy).

**Acceptance criteria:**
- AC10.1 A close-checklist item auto-verifies from `bank_reconciliations` that every active bank account for the entity/period is reconciled with difference = 0; HARD_CLOSE is blocked (or explicitly overridden with reason + audit) otherwise.
- AC10.2 The close grid shows per-entity reconciliation status (accounts reconciled / outstanding difference).
- AC10.3 Adjusting entries created during reconciliation respect the target period's lock status (`enforce_period_lock`).

---

### Dimension 11 — QBO / Sage bank rec benchmark (Rule 14, NAMED DELTAS)

**Purpose (Rule 14, mandatory):** Itemize what the market leaders do that MeritBooks must **match** or **beat**. QBO's reconcile flow is the SMB bar; Sage adds multi-bank + bank rules. MeritBooks' differentiation is the **AI autopilot** (tiered auto/review/escalate) on a true book of record with a full Decision-Log audit.

| # | Capability | QuickBooks Online | Sage (Intacct / 50) | MeritBooks today | Verdict |
|---|---|---|---|---|---|
| B1 | Guided reconcile (beginning + ending balance, check off lines to $0) | Yes | Yes | Totals-only modal; no line check-off / running-diff (D4.2) | **MATCH** |
| B2 | Bank feed auto-match | Yes | Yes | Yes — composite scorer + tiers (strong) | **BEAT** — tiered auto/review/escalate |
| B3 | AI/rules-based categorization & match | Basic rules | Bank rules | AI composite + learned patterns + Decision Log | **BEAT** |
| B4 | Statement file import (CSV/OFX/QFX) | Yes | Yes | No — Plaid feed or typed totals only (D2.1) | **MATCH** |
| B5 | Manual bank-line entry (non-feed accts) | Yes | Yes | No (D2.2) | **MATCH** |
| B6 | Itemized outstanding checks/deposits | Yes | Yes | Lump-sum integers only (D1.2) | **MATCH** |
| B7 | Book adjusting entries from the rec (fees/interest) | Yes | Yes | No (D6.1) | **MATCH** |
| B8 | "Find the difference" assist | Yes | Partial | No (D6.2) | **MATCH** |
| B9 | Split / grouped-deposit matching | Yes | Yes | No (D3.2) | **MATCH** |
| B10 | Inter-account transfer detection | Yes | Yes | No (D3.3) | **MATCH** |
| B11 | Match deposits → open invoices (cash app) | Yes (receive payment) | Yes | Outflows→bills only (D3.1) | **BEAT** — AI cash application (GATE 8) |
| B12 | Reconciliation report (PDF) | Yes | Yes | None (D9.1) | **MATCH** |
| B13 | Undo / unreconcile with audit | Yes | Yes | No (D8.1) | **MATCH** |
| B14 | Reconciliation required to close period | Enforced in close | Yes | Not enforced (D10.1) | **BEAT** — auto-verified close gate |
| B15 | Per-line reconciled state persisted | Yes | Yes | Derived only, no `reconciliation_id`/`reconciled_at` on lines (D1.1) | **MATCH** (needs migration) |
| B16 | Multi-entity / multi-bank at scale | Weak (QBO) | Yes | Org-wide, RLS-scoped, entity-stitched | **BEAT** (via consolidation) |

**Where MeritBooks must BEAT (the moat):** the **AI autopilot** with tiered auto/review/escalate and a full Decision-Log audit (B2/B3), **AI cash application** matching deposits to open AR (B11, GATE 8), and a **reconciliation-required close gate** auto-verified from the data (B14). The long list of MATCH items (B1, B4–B10, B12, B13, B15) are table stakes — several are *below* QBO today and must be built to reach "Complete."

---

### Dimension 12 — Roll-up module-level acceptance gates

Beyond the per-dimension ACs, Bank Reconciliation is **Complete** only when:
- **AC-M1** A guard test asserts a reconciliation with difference = 0 finalizes and locks its lines; a non-zero difference cannot finalize without a posted adjustment.
- **AC-M2** A tenant-isolation test covers `bank_reconciliations` and the recon routes (RLS proven — the routes already use the scoped client; prove it).
- **AC-M3** The composite scorer's pure functions remain unit-tested; a schema-contract test asserts every `match_type`/`status` literal the recon code writes is accepted by its CHECK.
- **AC-M4** An integration test: bank line → accept bill match → bank-feed approve posts a balanced DR AP / CR Cash (no re-expense), and the line clears — the settlement chain (CANON-ANCHOR §3).
- **AC-M5** Every surface renders loading / empty / populated / error; destructive actions (unreconcile) confirm; lists paginate; no dead controls (Rules 3–5).
- **AC-M6** Adjusting entries and finalize respect `enforce_period_lock`; no reconciliation writes into a HARD_CLOSE period (Rule 11 — verified against the trigger).

---

### Dimension 13 — Data model changes required to reach Complete

Spec, not code — migrations serialize through the lead (Supabase first):
1. **`bank_transactions.reconciliation_id`** (FK → `bank_reconciliations`, nullable) **+ `reconciled_at`** — the missing per-line linkage (D1.1/D4.1). *This is the flagged probable migration; without it, undo/lock/line-audit are impossible.*
2. **`bank_reconciliations.previous_reconciliation_id`** + `beginning_balance_cents` — carry-forward beginning balance (D1.3).
3. **Outstanding-item detail** — either itemize outstanding checks/deposits (a `reconciliation_items` table) or reference the specific uncleared `bank_transactions` as outstanding (D1.2).
4. **Statement lines for non-feed accounts** — allow manual/imported `bank_transactions` (or a `statement_lines` table) with a source flag + duplicate key (D2.1/D2.2).
5. **Close-checklist auto-verify hook** — a checklist item type that reads `bank_reconciliations.is_reconciled` for the period (D10.1); likely no new table, wire `close_checklists.is_auto_verified`.
6. **Account roles** for adjustments: BANK_FEES_EXPENSE, INTEREST_INCOME — resolve **by role, not number** (D6.1, CANON-ANCHOR §2).
7. **Autonomy-dial** config for auto-accept tier (per-tenant, per-task) (D7.1).

All new tables/columns: `org_id` + RLS `org_id = get_org_id()`, cents = bigint, idempotent migration, guard tests. Attribution: `reconciled_by` written null-or-core-uuid (never a Clerk text id); human attribution to `core.action_log`.

---

### Dimension 14 — AI behavior (the automation pillar, all human-approved)

**Purpose:** AI does the matching labor; staff supervise; leaders verify (CANON-ANCHOR §1).
- **Match proposals (BUILT):** composite score + tier per uncleared line, best bill or learned pattern, with a human-readable explanation; proposal + human decision both audited to `core.action_log`. AI never posts GL, never clears money.
- **AI cash application (GATE 8, MISSING here):** match incoming deposits to open AR invoices, propose the application, human approves — the symmetric inflow side of what's built for outflows (D3.1). Specified in the Invoices FPB Dimension 14; this module surfaces the candidate.
- **Difference diagnosis (build):** AI proposes the likely cause of a non-zero difference (fee, transposition, duplicate) with reasoning (Dimension 6).
- **Guardrails (VIII.7):** advisory by default; auto-accept only via the per-tenant autonomy dial for the safest tier, with SoD on the AI (proposer ≠ finalizer); every AI action → Decision Log; ask ONE disambiguating question when ambiguous. AI routes only through `@meritbooks/core-ai` (metered to `core.ai_usage_log`, tenant budget enforced across the suite — CANON-ANCHOR §2).

**Acceptance:** AC14.1 every AI-proposed match/cash-application/diagnosis is logged with inputs + rationale and requires a human step before it clears anything (unless the autonomy dial explicitly enables the safest tier); AC14.2 no AI path holds an Anthropic key or calls the API directly.

---

### Dimension 15 — RBAC & segregation of duties

**Purpose:** Reconciliation is a control; the person who reconciles should not be the person who can silently alter the underlying transactions.

**Current state — PARTIAL:**
- Routes are auth-gated (`requireAuthedContext`) and RLS-scoped (good, the reference pattern). Match accept/reject is attributed.
- **No role gate:** any authed org user can create/finalize a reconciliation, accept matches, or (once built) unreconcile. Consistent with the standing NO-GO RBAC gate (task #9).

**Named deltas / gaps:**
- **D15.1 — No `reconciliation:*` permission gates** (`lib/rbac/permissions.ts`) — finalize and especially **unreconcile** should require an elevated role.
- **D15.2 — No SoD** — the same actor can reconcile and (via other modules) re-post the cleared transactions; at minimum unreconcile/adjusting-entry should be role-gated and reconciled to `core.users/memberships/roles` (not the `core.employees.role` stopgap — CANON-ANCHOR §3, task #27).

**Acceptance criteria:**
- AC15.1 Finalize requires `reconciliation:reconcile`; unreconcile and adjusting-entry require an elevated permission; denied requests return the standard `permissionDenied`.
- AC15.2 Authorization reconciles to `core` identity, not `core.employees.role`.
- AC15.3 A tenant-isolation test proves org B cannot see or act on org A's reconciliations.

---

### Dimension 16 — Current-state ledger row (Rule 15) + analytics

| Dimension | State | Evidence |
|---|---|---|
| 1 Data captured | 🔶 Partial | `bank_reconciliations` (007) solid; no per-line linkage / beginning balance |
| 2 Statement import/entry | 🔶 Partial | Plaid feed; no CSV/OFX import, no manual line entry |
| 3 Matching engine | ✅ Built | composite scorer + tiers (outflows/bills) |
| 4 Cleared/uncleared | 🔶 Partial | derived only; no per-line reconciled flag / check-off UI |
| 5 Completion/finalize | 🔶 Partial | difference→is_reconciled; no explicit finalize/lock |
| 6 Discrepancy/adjustment | ❌ Missing | difference shown; no adjusting-entry path |
| 7 Autopilot | 🔶 Built-unverified | proposals + tiers + audit; browser-unverified (task #18); no auto-accept dial |
| 8 Lifecycle/undo | 🔶 Partial | match audited; no unreconcile, no line-detail drill |
| 9 Recon reports/export | ❌ Missing | no rec report / PDF / XLSX |
| 10 Close-gate integration | 🔶 Partial | HARD_CLOSE blocked in modal; not an enforced close gate |
| 11 Benchmark | — | see Dimension 11 |
| 15 RBAC/SoD | 🔶 Partial | RLS-scoped; no role gates |

**Analytics (to add):** per-account reconciliation status (last reconciled period, outstanding difference), stale-outstanding-check aging, average days-to-reconcile, and unreconciled-account count on the dashboard.

Overall: **Functional — partial.** Not Complete. The matching engine and autopilot are genuine strengths; the gaps are the **classic controller mechanics** (per-line clearing, adjusting entries, finalize/undo, rec report) and the **close-gate + per-line data model** (D1.1 migration is the keystone).

---

## §2. Build sequence — Functional-partial → Complete

Strictly ordered; each slice behind the wave pipeline (FPB → disjoint slices → builder wave → verifier + chrome-auditor + security for money/identity → reviewer → integrate → scribe). Migrations to Supabase first.

**Wave A — Data-model keystone & verification (blockers, do first):**
1. **Migration: `bank_transactions.reconciliation_id` + `reconciled_at`** (and `bank_reconciliations.previous_reconciliation_id` + `beginning_balance_cents`) — the per-line linkage everything else needs (D1.1, AC1.2). *Keystone.*
2. **Browser-verify the autopilot** with real data (task #18): matched/uncleared/tier counts, accept stages the match, reject flags to `/exceptions`; add the settlement-chain integration test (AC-M4).
3. **Tenant-isolation + schema-contract guard tests** for reconciliation (AC-M2/AC-M3).

**Wave B — Classic controller mechanics (reach QBO parity):**
4. **Interactive check-off + running-difference-to-$0** statement-rec UI, persisting per-line cleared state; **explicit finalize/lock** stamping `reconciled_at`/`reconciled_by` (D4.2/D5.1, AC4/AC5).
5. **Adjusting entries from the rec** (bank fees/interest/error) via `postJournalEntry`, role-resolved accounts, period-lock respected (D6.1, AC6.1/AC-M6).
6. **Unreconcile / undo** with full audit and line un-clearing (D8.1, AC8).

**Wave C — Import & matching depth:**
7. **Statement import (CSV/OFX/QFX) + manual bank-line entry** for non-feed accounts, with duplicate detection (D2, AC2).
8. **Split/grouped matching + inter-account transfer detection** (D3.2/D3.3, AC3.3/AC3.4).
9. **Itemized outstanding checks/deposits** + carry-forward beginning balance (D1.2/D1.3).

**Wave D — Reports, close gate & analytics:**
10. **Reconciliation report (PDF) + XLSX export + outstanding-items aging report** (D9, AC9).
11. **Close-gate auto-verify** — a `close_checklists` item that reads `bank_reconciliations.is_reconciled` and blocks HARD_CLOSE on unreconciled/out-of-balance accounts; per-entity rec status in the close grid (D10, AC10).
12. **Reconciliation analytics** on the dashboard (last-reconciled, outstanding difference, stale checks, days-to-reconcile).

**Wave E — AI depth & governance (the BEAT + the pillar):**
13. **AI cash application** — match deposits to open AR invoices, propose, human-approve (D3.1/Dimension 14; coordinate with the Invoices FPB / GATE 8).
14. **Autonomy dial + batch-accept** for the safest tier with SoD + Decision-Log audit; feed accept/reject into pattern learning (D7.1/D7.2/D7.4, AC7).
15. **RBAC enforcement** — `reconciliation:*` gates (finalize/unreconcile/adjust), reconciled to `core` identity (D15, AC15). *Coupled to the standing NO-GO RBAC gate (task #9).*

**Deferred with reason (not required for first Complete):** "find the difference" AI diagnosis assist (D6.2 — nice-to-have once adjusting entries exist); multi-bank bank-rules engine (Sage parity, low priority for the target operator). State each deferral in the Ledger.

---

## §3. Definition of Complete for this module

Bank Reconciliation is **Complete** when: the per-line data-model keystone (Wave A) ships; the classic controller mechanics (Wave B — check-off to $0, finalize/lock, adjusting entries, undo) reach QBO parity and pass their acceptance criteria; import + matching depth (Wave C) and the reconciliation report + auto-verified close gate (Wave D) are built; the module-level gates AC-M1…AC-M6 are green (settlement chain posts DR AP / CR Cash with no re-expense, tenant isolation proven, period lock respected); every Rule-14 benchmark row is MATCH-or-better (or explicitly deferred with reason in the Ledger); and the verifier + chrome-auditor + security agents confirm TRUTH against the deployed app and live Supabase. Wave E (AI cash application, autonomy dial, RBAC) raises it toward **Verified**. Until then the Ledger row stays **Functional — partial**.
