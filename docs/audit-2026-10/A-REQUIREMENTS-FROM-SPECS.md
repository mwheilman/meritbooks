# A — Requirements from Specs: MeritBooks Master Feature List

_Audit 2026-10, workstream A. Compiled 2026-10-22. Read-only extraction from the owner's formal planning documents. This is a list of what was **specified**. It does not say what is built; any status shown is the status the source document claimed when it was written._

## How to read this

- **ID.** A plain number (e.g. `48`) is Mike's own item number from `meritbooks-exhaustive-feature-audit.md` (April 5, 2026). His numbering runs **1–436**, not 461 (see Contradictions). `S-xxxx` is a new ID for a requirement that isn't in the audit. S-IDs are ordered by domain.
- **Source codes.** Plain text means a doc I read directly:
  - **BuildSpec v4.3** = `MeritBooks-Architecture-Build-Spec-v4_3.md`
  - **MD9** = `MeritBooks-Master-Document_9.md`
  - **Posting Engine Spec** = `MeritBooks-Transaction-Posting-Engine-Spec.md`
  - **Platform Design Criteria**, **Suite Architecture** (`merit-suite-architecture.md`), **Event Contract** (`merit-suite-event-gl-posting-contract.md`)
  - **Handoff S7–S10, S36, S37** = the project-knowledge handoffs; **CLAUDE.md** = the repo file (its owner-specified Bank Feed list)
- **Bracketed prefixes** mark rows extracted by three parallel read-only sub-agents, each of which read its files in full:
  - **[H]** = repo handoffs S38–S50 plus `docs/canon/*` and `docs/ia/00-OWNER-DIRECTIVE.md`.
    - `S38`–`S50` = `docs/MERITBOOKS-HANDOFF-sessionNN.md`; `ANCHOR` = `canon/CANON-ANCHOR.md`.
    - `D10`/`D20`/`D30`/`D40` = the canon digests (suite contracts, build spec + posting engine, rules/audit/memory, master doc S37).
    - `OD` = owner directive 2026-10-18.
  - **[D1]** = `docs/discovery/` catalogs and operator briefs plus `COMPETITIVE-GAP-ANALYSIS-2026-10.md`.
    - `CATv2` = AI-CAPABILITY-CATALOG-v2; `CATv1` = books/AI-CAPABILITY-CATALOG; `MATRIX` = AI-CAPABILITY-MATRIX; `COV` = COVERAGE-MATRIX.
    - `ERP` = ERP-INTEGRATION-LANDSCAPE; `INT` = INTEGRATION-MAP; `GAP` = COMPETITIVE-GAP-ANALYSIS.
    - Operator briefs: `FIRM` (accounting-firm partner), `MGR` (accounting manager), `BKP` (bookkeeper/processor), `CFO` (controller/CFO), `CPA` (CPA tax & assurance).
    - Priority notation: value tier + score (e.g. `Crit 4.20`); `Top30 #n` = MATRIX §4 rank; `v2-BN #n` = CATv2 §4 rank; `GAP T1/T2/T3` (T1 = needed for Merit go-live); `Gate n`.
  - **[D2]** = `docs/discovery/segments/*` and `docs/discovery/ai-modality/*`.
    - Segments: `AP`, `AR`, `BC` (bank-cash), `FPA`, `GLC` (gl-close), `TAX`.
    - AI-modality docs: `FTP` (fpna-tax-payroll-practice), `P2P` (p2p-o2c), `R2R` (record-to-report). `M1–M14` = AI-modality columns.
- **Priority / status column.** For audit rows this gives:
  - the April 2026 audit status;
  - the Master Doc v9 register status (✅ built · 🔶 partial · ⬜ schema · ❌ missing · ⛔ retired);
  - the build-sequence tier from the audit (P0–P6).
  - For other rows it is whatever the source stated (gate, tier, BUILT/OPEN, "Mike's ask", and so on).
- **Deduplication.** Rows describing the same capability were merged and all their sources kept. Near-duplicates with different depth were left as separate rows on purpose, because the extra granularity is the point. Retired items are collected in the final domain so nobody rebuilds them.

### Requested features with no source

These were raised in the brief but no formal document specifies them:

- **Check printing on stock with a MICR line.** No document mentions MICR. The spec only says "print physical checks" plus the positive-pay file.
- **Check mailing.** No document specifies it.
- **Per-company AP inbox email address.** The spec'd and built version is per **tenant** (`inbound_ap_address`, S48), and Master Doc GATE 4 describes a per-tenant list of mailboxes. The only per-entity mention is GAP §3B #14, "Per-entity AP inbox agent".
- **Splitting a bank transaction across GL accounts and companies.** This *is* specified, in three places:
  - line splits at review (Posting Engine Spec Part G);
  - multi-line, multi-job splits on one document (Part E6);
  - shared-card splits across entities and GL accounts (CATv2 BC-A5).

## Row counts by domain

| Domain | Rows | of which owner-audit # |
|---|--:|--:|
| Bank feed & categorization | 86 | 15 |
| Receipts & receipt chase | 39 | 18 |
| AP / bills incl. email intake, POs | 90 | 16 |
| Vendor management & W-9/COI chase | 45 | 12 |
| Check processing (print, positive pay, mailing) | 17 | 5 |
| Payments / ACH / money movement | 49 | 6 |
| AR / invoicing / collections | 134 | 14 |
| Revenue recognition & WIP (incl. unbilled 1180, deferred 2410, over/under billings) | 72 | 8 |
| Job costing & project accounting | 32 | 13 |
| Payroll | 41 | 3 |
| Expenses | 29 | 10 |
| Bank reconciliation | 43 | 4 |
| Close (month-end, year-end, working papers, controls) | 80 | 26 |
| GL / journal entries / COA (incl. split transactions) | 102 | 34 |
| Fixed assets, leases & schedules | 68 | 24 |
| Debt, equity & covenants | 26 | 3 |
| Intercompany / inter-department / consolidation | 52 | 7 |
| Tax / 1099 / sales tax / compliance | 71 | 9 |
| Reporting (every named report) | 123 | 42 |
| FP&A, budgets, cash forecasting | 116 | 32 |
| Dashboards per role & team performance | 59 | 18 |
| Practice management | 49 | 11 |
| AI agents & automation | 99 | 18 |
| Onboarding & migration | 70 | 13 |
| Integrations | 53 | 0 |
| Portals (client, vendor, customer) | 12 | 1 |
| Admin / RBAC / identity / security | 74 | 21 |
| Mobile / workforce app | 15 | 8 |
| Notifications | 6 | 0 |
| Platform, billing & white-label | 29 | 3 |
| UI, design system & navigation | 15 | 3 |
| Other | 8 | 0 |
| Retired / superseded — do NOT build | 49 | 39 |
| **Total** | **1853** | **436** |

## Bank feed & categorization

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 73 | Bank account connection via Plaid | MD9 note: LIVE — Link/exchange/sync/Vault; verified (Session 24) | Audit #73 (Cat 4); BuildSpec v4.3 §04 Banking, §06; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅; seq P1-HIGH |
| 74 | Bank feed transaction import (automated daily) | MD9 note: Plaid /transactions/sync, cursor+dedupe (Session 24); scheduled daily pull still TODO | Audit #74 (Cat 4); BuildSpec v4.3 §04 Banking, §06; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅; seq P1-HIGH |
| 75 | Manual bank file import (CSV, QIF, XLS, OFX, BAI2, CAMT.053) | Import CSV, QIF, XLS, OFX, BAI2, CAMT.053 | Audit #75 (Cat 4); BuildSpec v4.3 §04 Banking, §06; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH |
| 76 | AI transaction categorization (Claude + vendor pattern cache) | Claude + vendor pattern cache (78% cache hit). MD9 note: categorization.ts; not live Claude | Audit #76 (Cat 4); BuildSpec v4.3 §04 Banking, §06; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶; seq P1-HIGH |
| 77 | 3-step matching algorithm (vendor 40% + amount 40% + date 20%) | Vendor 40% + amount 40% + date 20%. MD9 note: in categorization.ts | Audit #77 (Cat 4); BuildSpec v4.3 §04 Banking, §06; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶; seq P1-HIGH |
| 78 | Confidence-based routing (≥90% auto / 70-89% review / <70% flagged) | ≥90 auto / 70–89 review / <70 flagged. MD9 note: confidence-bar.tsx; flagged page | Audit #78 (Cat 4); BuildSpec v4.3 §04 Banking, §06; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶; seq P1-HIGH |
| 81 | Credit card feed import and reconciliation | MD9 note: credit-cards page wired | Audit #81 (Cat 4); BuildSpec v4.3 §04 Banking, §06; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶; seq P1-HIGH |
| 160 | Bank Feed — AI-categorized transactions with confidence bars | MD9 note: wired | Audit #160 (Cat 7); BuildSpec v4.3 §09; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅ |
| 161 | Bank Feed — Match status badges (matched to bill/receipt/unmatched) | MD9 note: wired | Audit #161 (Cat 7); BuildSpec v4.3 §09; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅ |
| 162 | Bank Feed — 3 actions per transaction (Approve, Flag, Edit) | MD9 note: wired | Audit #162 (Cat 7); BuildSpec v4.3 §09; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅ |
| 163 | Bank Feed — Batch approve for high-confidence items | Batch approve high-confidence items | Audit #163 (Cat 7); BuildSpec v4.3 §09; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 172 | Flagged Items — Low-confidence review queue | MD9 note: wired | Audit #172 (Cat 7); BuildSpec v4.3 §09; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅ |
| 173 | Flagged Items — AI note explaining uncertainty |  | Audit #173 (Cat 7); BuildSpec v4.3 §09; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶 |
| 174 | Flagged Items — Inline resolve with notes | Manager resolves inline; note becomes audit trail | Audit #174 (Cat 7); BuildSpec v4.3 §09; MD9 Part V | Apr-26 audit: MISSING; MD9: ✅ |
| 298 | Corporate card feed import and management | MD9 note: page | Audit #298 (Cat 14); BuildSpec v4.3 §04, §24; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶; seq P5-LOWER |
| S-0001 | Matching step 1 — vendor pattern match vs 100 most recent confirmed receipts/bills at 85% fuzzy (Levenshtein) similarity |  | BuildSpec v4.3 §06 |  |
| S-0002 | Matching step 2 — bill-payment match: amount ±2%, date window ±60 days (handles discounts, adjustments, partial payments) |  | BuildSpec v4.3 §06 |  |
| S-0003 | Matching step 3 — receipt match for card transactions: ±$5, ±3 days |  | BuildSpec v4.3 §06 |  |
| S-0004 | Separate AI confidence thresholds: ≥85% auto-approve candidate, 50–84% human review, <50% flagged | In addition to composite-score routing ≥90/70–89/<70 | BuildSpec v4.3 §06 |  |
| S-0005 | Auto-approve rule: confidence ≥85% AND trusted vendor (auto_approve=true) AND amount ≤ $10,000 |  | BuildSpec v4.3 §06; CLAUDE.md Business Rules |  |
| S-0006 | Transaction lifecycle state machine PENDING → CATEGORIZED → APPROVED → POSTED, with FLAGGED and POST_ERROR branches |  | BuildSpec v4.3 §06 |  |
| S-0007 | Review screen shows AI suggestion alongside original document, confidence score and reasoning; one-click approve / edit / flag; every correction updates vendor pattern cache |  | BuildSpec v4.3 §06 stage 5 |  |
| S-0008 | Bank feed company/account filters; matching runs continuously in background linking transactions to source docs |  | BuildSpec v4.3 §09 |  |
| S-0009 | Flagged Items queue: source, company, who flagged (AI or human), detailed note (e.g. "Unknown vendor — $542 — 34% confidence"; "Rev Rec — cost variance 18%"); manager resolves inline, note goes to audit trail |  | BuildSpec v4.3 §09 |  |
| S-0010 | Plaid entity-first connect: entity resolved before Plaid opens (presumed when scoped to company, else one picker); per-account step only GL + label; staging before promotion; non-cash accounts can be ignored | Connecting a bank is an ongoing per-company feature, not wizard-only | MD9 XI.11 B | BUILT |
| S-0011 | Bank-feed edit panel: full active COA grouped by type (incl. COGS) scoped to entity; department/class/job pickers honoring entity require_* flags; AI categorize parallelized (<90s for 48) | Mike's explicit ask | MD9 XI.11 E–F | Built S25–35 |
| S-0012 | Bank-account manager: inline rename / GL reselect for connected accounts |  | MD9 XI.11 A | BUILT |
| S-0013 | Batch approval over a filtered review queue: filter by amount range, confidence, transaction type, vendor/customer, account, job/department, date/age; approve whole filtered set; each item posts individually with partial success and per-item reasons | Judgment/flagged/low-confidence items excluded from blind batch by default; batch filter + covered entries logged | Posting Engine Spec Part G |  |
| S-0014 | Saved review-filter presets (e.g. "auto-approvable: known vendor, < $100, confidence > 0.9") |  | Posting Engine Spec Part G |  |
| S-0015 | Bank-feed bill-payment recognition: a bank payment matched to an existing bill clears AP (no double-count) |  | Posting Engine Spec Part D, E verification |  |
| S-0016 | Bank transfer between own accounts recognized (both sides cash) — no income/expense |  | Posting Engine Spec B3 |  |
| S-0017 | Undeposited funds clearing account; NSF/bounced payment reversal + NSF fee |  | Posting Engine Spec B3 |  |
| S-0018 | Credit-card statement payment settles card payable (must not re-expense charges); card refunds/credits |  | Posting Engine Spec B4 |  |
| S-0019 | Bank feed status tabs with dollar amounts per status; debounced search; pagination (50/page); toasts with JE number; keyboard shortcuts j/k/a/f/Space/Esc | Owner-required "already built — keep" | Handoff S7 §1; CLAUDE.md Bank Feed | BUILT S7 |
| S-0020 | Processing metrics strip: processed today X/Y (Z%), AI auto-approved count, average confidence | Owner-required enhancement | CLAUDE.md Bank Feed; Handoff S7 |  |
| S-0021 | Smart batch selection "Select all ≥90% confidence" | Owner-required | CLAUDE.md Bank Feed; Handoff S7 |  |
| S-0022 | Vendor batch selection: click vendor name to select all its transactions | Owner-required | CLAUDE.md Bank Feed; Handoff S7 |  |
| S-0023 | Sortable columns: date, amount, confidence, vendor, company | Owner-required | CLAUDE.md Bank Feed |  |
| S-0024 | Sort by confidence lowest-first (needs most attention) | Owner-required | CLAUDE.md Bank Feed (Spec §09) |  |
| S-0025 | Edit slide-out: vendor name, GL account search with vendor recents (top 5 most-used accounts for this vendor), AI reasoning, notes, Save & Approve | Owner-required | CLAUDE.md Bank Feed; Handoff S7 |  |
| S-0026 | Inline-editable AI Category (GL account) and Project/Job columns directly in the bank-feed table; edit panel only for rare actions | Mike: "Make things easy to edit in the main dashboard" | Handoff S7 §4–5 | Requested S7 |
| S-0027 | Company selector on bank feed; job selector; COGS (5xxx) accounts require a job, non-COGS optional |  | Handoff S7 §1 |  |
| S-0028 | Flag action creates flagged item (POST /bank-feed/flag) |  | Handoff S7 |  |
| S-0029 | Inline-edit PATCH with audit trail and vendor pattern learning; aging dots (>24h amber, >48h red); flag dialog with reason |  | Handoff S8 §1, §5 | BUILT S8 |
| S-0030 | Flagged Items aggregates flagged bank txns + receipts + on-hold bills |  | Handoff S8 §1 | BUILT S8 |
| S-0031 | Plaid live bank + credit-card feed | Connect per entity first; Plaid's positive amount (money out) is flipped to a negative ledger amount; 8 accounts / 48 transactions proven | [H] D40 Part VII 12.0, Part XI; ANCHOR §5 | GATE 12.0 DONE & verified live; Plaid still SANDBOX (S48 §4) |
| S-0032 | Seven-stage processing pipeline | Ingest → Extract (AI OCR) → Categorize (cache first, about 78% at zero cost, otherwise Claude with the full chart of accounts) → Score → Review (human gate) → Post → Audit | [H] D20 Build Spec | Canon |
| S-0033 | Matching cascade | Vendor pattern (100 recent, 85% Levenshtein) → bill payment (±2% amount, ±60 days) → receipt (±$5, ±3 days) | [H] D20 Build Spec | Canon |
| S-0034 | Composite match score and routing | Vendor 40% + Amount 40% + Date 20%. ≥90% auto-categorize, 70–89% review, <70% flagged | [H] D20; D40 Part VIII; CLAUDE.md Business Rules | Canon |
| S-0035 | Auto-approve rule | Confidence ≥85% AND trusted vendor (`auto_approve=true`) AND amount ≤ $10,000; auto-post OFF by default | [H] D20; CLAUDE.md | Canon; per-tenant dial |
| S-0036 | AI-sorted review list | Lowest confidence first, confidence bars, match-status badges (matched to bill / receipt / unmatched) | [H] CLAUDE.md Bank Feed Core (Audit #160–163) | Required |
| S-0037 | Approve / Flag / Edit per transaction + batch approve | Three actions per row; batch approve high-confidence items | [H] CLAUDE.md Bank Feed Core | Required |
| S-0038 | Processing metrics strip | Processed today X/Y (Z%), AI auto-approved count, average confidence | [H] CLAUDE.md Enhancements | Required |
| S-0039 | Smart and vendor batch selection | "Select all ≥90%"; click a vendor name to select all its transactions; S49 adds bulk select by confidence band or vendor | [H] CLAUDE.md; S49 §2 | Built (S49) |
| S-0040 | Sortable columns | Date, amount, confidence, vendor, company | [H] CLAUDE.md | Required |
| S-0041 | Edit slide-out panel | Vendor name, GL account search with the vendor's 5 most-used accounts, AI reasoning, notes, Save & Approve | [H] CLAUDE.md | Required |
| S-0042 | Keyboard shortcuts, dollar totals in tabs, toasts, debounced search | j/k/a/f/Space/Esc | [H] CLAUDE.md "Already built" | Built |
| S-0043 | Bank-feed saved views | Saved filter views, with tests | [H] S49 §2 (`43ff536`) | Built |
| S-0044 | Deterministic confidence explainer | Explains why the confidence is what it is, without AI | [H] S49 §2 | Built |
| S-0045 | Tier-driven disposition | Categorizer runs `scoreToTier`; escalate-tier items go to FLAGGED → exception queue | [H] S39 §8; S40 §5 | Built; full auto-post disposition still pending |
| S-0046 | Settlement clears AP, never re-expenses | A bank txn matched to a bill posts DR AP / CR Cash using `matched_bill_id` | [H] S40 §2; ANCHOR §3 | Built |
| S-0047 | Credit-card handling | Charge: DR Expense / CR Credit Card Payable (a liability). Statement payment: DR CC Payable / CR Cash, never re-expensed. Credit Cards tab folded into bank feed | [H] D20 transaction universe; S47 autonomous log | Built |
| S-0048 | Transfers between own accounts | DR receiving bank / CR sending bank; never income or expense | [H] D20 | Canon rule |
| S-0049 | Bank fee and interest income templates | Fee: DR Fee Expense / CR Cash. Interest: DR Cash / CR Interest Income | [H] D20 | Canon |
| S-0050 | Split / override at review | Every field editable before posting (account, dimensions, rail, splits, tax, GAAP election). AI suggestion is the default, not a lock. Overriding a flagged item needs a documented reason | [H] D20 Override at review | Canon; no dedicated split UI stated |
| S-0051 | Batch approval that can partly succeed | Each entry posts individually; never silently all-or-nothing. Judgment items (defer, capitalize, prepaid, WIP, low confidence) excluded from blind batch | [H] D20 | Canon |
| S-0052 | Vendor → GL learning memory (M14) | Learns coding from approved history and proposes it next time | [H] S44 §2; ANCHOR §5 | Built (opened) |
| S-0053 | Apply Deposits tab (cash application on the bank feed) | Folded into the bank-feed page | [H] S47 autonomous run log | Built |
| S-0054 | GATE 5: confidence routing and learning | Re-tune confidence weights; open decision | [H] D40 Part VII, Part X | OPEN |
| S-0055 | AI bank/credit-card feed auto-categorization | GL account and dimensions proposed for every line. Sorted lowest confidence first, with a confidence bar and the AI's reasoning. One-click and batch approve. Composite score = vendor 40% / amount 40% / date 20%. ≥90% auto, 70–89% review, <70% flag. Auto-approve only if ≥85% AND trusted vendor AND ≤$10k, always reversible and logged. If the autonomy dial is off, everything is propose-only. IDs A1 / BC-A2 / CORE-1. | [D1] CATv1 §1 A1; CATv2 §2.5 BC-A2; BKP CORE-1; CFO #4; MGR B3; INT §2.1; [D2] BC Group A; P2P S3 M2; R2R S3 M2 | Crit 4.75; built (Gate 12.0/3); flagship; BUILT; common-core |
| S-0056 | Plaid bank and card feed ingestion | Webhook plus `plaid/sync` cursor pull. Pending items reconciled to posted on the next pull. Per-Item access_token kept in Vault. BC-A1. | [D1] CATv2 BC-A1; INT §2.1; [D2] BC Part 2 Group A | High 3.60; built; BUILT, live (GATE 12.0); common-core |
| S-0057 | Plaid account mapping and health diagnostics | `plaid/map` (Plaid account → internal account) and the `plaid/diag` health route | [D1] INT §2.1 | built |
| S-0058 | Vendor-pattern learning loop | Learns vendor descriptor → GL/dimension from past coding. Handles one vendor appearing under several descriptor strings. BC-A3. | [D1] CATv2 BC-A3; BKP Part 1; MATRIX §2 (M14); [D2] BC Group A; P2P S3 M14; R2R S3 M14 | High 3.40; built; BUILT (`learnVendorPattern`) |
| S-0059 | Feed-vs-bill double-count block | At categorization, flag a feed line whose bill was already entered (and the reverse). BC-A4. | [D1] CATv2 BC-A4; BKP Part 1 & CORE-3 | High 3.50; partial |
| S-0060 | Shared-card split and dimension tagging | Split one card or statement line across entities and GL accounts; tag location/department/class. BC-A5. | [D1] CATv2 BC-A5; BKP Part 1; [D2] BC Group A | Med 3.05; partial; PARTIAL (edit panel only; no multi-line split proposal); common-core |
| S-0061 | Card-line categorization with MCC → GL hint | Same engine as the bank feed. Card settlement posts to Credit Card Payable, never to cash. | [D1] INT §2.2 | partial (rides Plaid) |
| S-0062 | Flag personal or owner charges on business cards | Catches charges like an Amazon personal purchase; links to the owner-benefit classifier | [D1] BKP Part 1; CATv2 TX-E3 | High 3.25 (TX-E3); none |
| S-0063 | Stale-feed / balance-freshness monitor | Flags stale `balance_updated_at` or Plaid item `login_required` so cash position isn't trusted blindly (BC C2) | [D1] CATv2 BC-C2; [D2] BC Group C; P2P S3 M12; R2R S3 M12 | Med 3.00; partial; PARTIAL (status exists; no dashboard alert) |
| S-0064 | Vendor-recents and inline GL search in the edit panel | Polish gap called out for the Bank/Cash segment | [D1] COV #6 | gap |
| S-0065 | BAI2 type-code → GL mapping | AI maps BAI2 type codes to GL accounts and flags balance breaks | [D1] INT §2.1 | none |
| S-0066 | Feed-vs-bill double-count / already-booked guard | Flags a feed payment already booked as a bill (and vice versa); fuzzy vendor+amount+date; blocking side-by-side; never auto-deletes (BC A4, AP G3) | [D2] BC Group A; AP Group G; P2P S1 M3 | PARTIAL (detect-only dup control; not a blocking gate at categorization) |
| S-0067 | Bank-fee anomaly / analysis-statement audit | Tracks recurring fees per account; flags new or jumped fees and unused services; reconciles the analysis statement (BC E5) | [D2] BC Group E; P2P S3 M4 | MISSING; Tier 3 (Payment-Fraud Controls FPB) |
| S-0068 | NSF / return / overdraft tracking | Detects NSF/returned-item/overdraft lines; for a returned customer deposit, reverses cash application and re-opens the invoice (BC E6) | [D2] BC Group E; P2P S7 M12 | MISSING; Tier 3 |
| S-0069 | Interest & investment-income tracking | Codes interest and sweep/investment returns to the right income account; expected vs received on swept balances (BC E7) | [D2] BC Group E | PARTIAL (B4 books interest in rec only) |
| S-0070 | Anomalous cash-account entry detection (EC-10 over cash) | Round-dollar spikes, off-hours, atypical vendor/amount on cash entries (BC F8) | [D2] BC Group F | Detect-only BUILT (`anomalous-je.ts`) |
| S-0071 | Retrieval over transaction/rec history | "Show every prior match for this descriptor" | [D2] P2P S3 M13 | NONE ⭐NEW |

## Receipts & receipt chase

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 164 | Credit Cards — Transaction review with receipt matching status | MD9 note: wired | Audit #164 (Cat 7); BuildSpec v4.3 §09; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅ |
| 165 | Credit Cards — Chase indicator (reminder count) | Reminder count shown per card transaction | Audit #165 (Cat 7); BuildSpec v4.3 §09; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 166 | Receipts — AI extraction with pre-populated fields | MD9 note: wired | Audit #166 (Cat 7); BuildSpec v4.3 §09; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅ |
| 167 | Receipts — Original image alongside extracted data | Original image beside extracted fields | Audit #167 (Cat 7); BuildSpec v4.3 §09; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 168 | Receipts — Source indicator (email/mobile/manual) | Email / mobile / manual | Audit #168 (Cat 7); BuildSpec v4.3 §09; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 169 | Receipts — Batch approve |  | Audit #169 (Cat 7); BuildSpec v4.3 §09; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 289 | Receipt capture via mobile camera with AI OCR | Mobile camera capture with AI OCR. MD9 note: in scope | Audit #289 (Cat 14); BuildSpec v4.3 §04, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P5-LOWER |
| 290 | Receipt capture via email forwarding (M365 inbox) | Forward receipts to M365 inbox. MD9 note: CORE | Audit #290 (Cat 14); BuildSpec v4.3 §04, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P5-LOWER |
| 291 | Receipt data auto-population (vendor, amount, date, category) | MD9 note: service | Audit #291 (Cat 14); BuildSpec v4.3 §04, §24; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶; seq P5-LOWER |
| 292 | Receipt-to-card matching (±$5 amount, ±3 days) | ±$5, ±3 days. MD9 note: service | Audit #292 (Cat 14); BuildSpec v4.3 §04, §24; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶; seq P5-LOWER |
| 293 | Receipt chase: push+SMS reminders until submitted | Push + SMS until submitted | Audit #293 (Cat 14); BuildSpec v4.3 §04, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P5-LOWER |
| 294 | Chase: configurable intervals (15m/30m/1hr/2hr/4hr) | 15m / 30m / 1h / 2h / 4h | Audit #294 (Cat 14); BuildSpec v4.3 §04, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P5-LOWER |
| 295 | Chase: escalation thresholds and supervisor notification | Escalate after 3/5/10 reminders or 24h → supervisor | Audit #295 (Cat 14); BuildSpec v4.3 §04, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P5-LOWER |
| 296 | Chase: quiet hours (configurable per org) | Configurable per org (default 9 PM–6 AM) | Audit #296 (Cat 14); BuildSpec v4.3 §04, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P5-LOWER |
| 297 | Chase: auto-approve threshold ($10/$25/$50/$100/Never) | $10 / $25 / $50 / $100 / Never (default $25) | Audit #297 (Cat 14); BuildSpec v4.3 §04, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P5-LOWER |
| 353 | Settings — Receipt Chase full configuration (timing, escalation, channels, quiet hours, auto-approve) | Timing, escalation, channels, quiet hours, auto-approve | Audit #353 (Cat 17); BuildSpec v4.3 §24, §08; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 354 | Settings — Credit Card Assignments (card → cardholder mapping) | Card → cardholder mapping | Audit #354 (Cat 17); BuildSpec v4.3 §24, §08; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 426 | Configurable quiet hours per-org (replacing hardcoded 9PM-6AM) |  | Audit #426 (Cat 23); BuildSpec v4.3 §25; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| S-0072 | Credit Cards screen mirrors Bank Feed + receipt-submitted status + number of reminders sent + link to chase settings | "Chase is relentless by design — continues until receipt submitted" | BuildSpec v4.3 §09 |  |
| S-0073 | Receipts screen: every field pre-populated (vendor, amount, date, GL, job, company); image beside data; source indicator (email/mobile/manual); batch approve high-confidence |  | BuildSpec v4.3 §09 |  |
| S-0074 | Mobile receipt submission confirmation shows AI category assigned (e.g. "5000 · Materials (COGS)") and stops chase; job picker includes "Not for a specific job" |  | BuildSpec v4.3 §15 |  |
| S-0075 | Mobile home: overdue receipt count with escalation status; chase cards with reminder count, next ping time, escalation status |  | BuildSpec v4.3 §15 |  |
| S-0076 | Receipt chase is event-driven: card transaction posts → immediate push+SMS; follow-ups at configured interval until receipt submitted |  | BuildSpec v4.3 §19 |  |
| S-0077 | Receipt chase config parameters & defaults: first reminder immediate–1hr (default immediate); follow-up 15m/30m/1h/2h/4h (30m); escalate after 3/5/10 reminders, 24h, or never (5); quiet hours (9PM–6AM); channels Push+SMS / Push / SMS / Push+SMS+Email (Push+SMS); auto-approve $10/$25/$50/$100/Never ($25) |  | BuildSpec v4.3 §24 |  |
| S-0078 | Credit card assignments: map each card to cardholder for chase notifications |  | BuildSpec v4.3 §24 |  |
| S-0079 | Receipts page + receipt matching | Matched ±$5 / ±3 days | [H] D40 Part IV; D20 | Deployed |
| S-0080 | Automated receipt chase | Push + SMS; escalate at 3/5/10 days; quiet hours 9pm–6am; thresholds $10/$25/$50/$100 | [H] D40 Part VIII | Standing business logic; no build status given |
| S-0081 | Unposted-receipt leakage detection | EC-4 flags receipts unposted >30 days | [H] S41 §2 | Built (detect-only) |
| S-0082 | Company derived from header | In-page company selector removed | [H] S48 §2 | Built |
| S-0083 | Receipt-to-charge matching | Match uploaded, emailed or texted receipts to card charges on amount + date + vendor. One-tap confirm. Show unmatched items on both sides. Image attached to the charge as substantiation. A3 / CORE-5. | [D1] CATv1 A3; BKP CORE-5; CPA A5 | 3.75; Gate 8 |
| S-0084 | Live "missing receipts" list per person with auto-nudge | The machine does the chasing; the bookkeeper watches the count drop | [D1] CATv1 A3; BKP CORE-5 | — |
| S-0085 | Receipt capture and OCR parse | `/receipts`, `receipts/submit` and `receipts/categorize` extract vendor/amount/date/tax and propose GL coding plus a match | [D1] INT §2.2; [D2] P2P S8 M1 | built (bypasses AI gateway, F1); partial (`receipts/submit`, `receipts/categorize`) |
| S-0086 | Receipt chase by SMS and mobile capture | Competitors Docyt, Zeni and Ramp have this | [D1] GAP §3D #31 | T3; missing |
| S-0087 | Missing-receipt chase plus card-program optimization | NEW-EX4 | [D1] CATv2 §6.2; MATRIX §3c | High; none |
| S-0088 | Receipt / card-transaction GL + dimension coding | Via the categorizer; no post/approve path yet | [D2] P2P S8 M2 | partial |
| S-0089 | Receipt ↔ card transaction ↔ bill 3-way match | 3-way match for spend; avoids double-count | [D2] P2P S8 M3 | partial (CC view shows match status; matcher spec); Seg 8 top-3 (a) |
| S-0090 | Missing-receipt / uncoded-card chase | Orchestrated chase (CC "chase count" column exists) | [D2] P2P S8 M11 | NONE ⭐NEW |
| S-0091 | Missing-receipt + uncoded-card-line aging + policy-breach alerting | Card-specific aging alerts | [D2] P2P S8 M12 | partial (uncategorized-leakage adjacent) ⭐NEW |
| S-0092 | Document-chase orchestration ("waiting-on" board) | For anything blocked on a missing doc or answer (W-9, COI, receipt, "what was this charge", "which job"): send + auto-follow-up; review-before-send or trusted-category auto-send; single waiting-on board (AP I8) | [D2] AP Group I | PARTIAL (cadence scheduled; send/reply/board unbuilt; send rides GATE 4); AP rank #10 |

## AP / bills incl. email intake, POs

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 29 | Bill entry with AI OCR extraction (scan/email/upload) | Scan / email / upload; AI extracts vendor, amounts, dates, lines, tax, terms. MD9 note: bills page + bill-parser; manual upload only | Audit #29 (Cat 2); BuildSpec v4.3 §04 AP; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶; seq P2-HIGH |
| 30 | Bill line items with dimensional coding (4 dimensions) | Bill lines coded to Location/Dept/Class/Item. MD9 note: bill_lines (4 dims) | Audit #30 (Cat 2); BuildSpec v4.3 §04 AP; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ⬜; seq P2-HIGH |
| 31 | Duplicate invoice detection | Detect duplicate vendor invoices before entry/payment. MD9 note: Session 11 | Audit #31 (Cat 2); BuildSpec v4.3 §04 AP; MD9 Part V | Apr-26 audit: MISSING; MD9: ✅; seq P2-HIGH |
| 32 | Configurable approval workflows (value-based, role-based) | Value-based and role-based routing | Audit #32 (Cat 2); BuildSpec v4.3 §04 AP; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 33 | Approval delegation for out-of-office approvers | Delegate approvals when approver out of office | Audit #33 (Cat 2); BuildSpec v4.3 §04 AP; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 34 | Vendor defaults (terms, discounts, GL, payment priority) — AI-learned | Vendor default terms, discounts, GL, payment priority — AI-learned. MD9 note: vendor_patterns; categorization.ts | Audit #34 (Cat 2); BuildSpec v4.3 §04 AP; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶; seq P2-HIGH |
| 35 | Recurring bills | MD9 note: recurring_templates | Audit #35 (Cat 2); BuildSpec v4.3 §04 AP; MD9 Part V | Apr-26 audit: SCHEMA; MD9: 🔶; seq P2-HIGH |
| 36 | 3-way match (PO → receipt → invoice) with tolerance exceptions | PO → receipt → invoice with tolerance exceptions. MD9 note: no PO system. Spec: Price/qty variance goes to the exception queue. AP-D2 | Audit #36 (Cat 2); BuildSpec v4.3 §04 AP; MD9 Part V; [D1] CATv2 AP-D2; INT §2.8; [D2] AP Group D; P2P S9 M3 | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH; Crit 4.00; none; Top30 #10; GAP; AP rank #2 (Gate 11b) |
| 43 | Vendor credits and debit memos | Vendor credits and debit memos applied to payables | Audit #43 (Cat 2); BuildSpec v4.3 §04 AP; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 44 | Purchase orders with approval workflows | POs with approval workflow | Audit #44 (Cat 2); BuildSpec v4.3 §04 AP; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 45 | PO-to-bill conversion (single and multi-document) | Convert one or many POs to a bill | Audit #45 (Cat 2); BuildSpec v4.3 §04 AP; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 46 | Purchase requisitions |  | Audit #46 (Cat 2); BuildSpec v4.3 §04 AP; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 47 | Spend management (budget controls on POs) | Budget controls on POs | Audit #47 (Cat 2); BuildSpec v4.3 §04 AP; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 170 | Bills — Vendor compliance status badge on bills | Missing W-9 / expired COI badge blocks inadvertent processing | Audit #170 (Cat 7); BuildSpec v4.3 §09; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 171 | Bills — Line-item detail view |  | Audit #171 (Cat 7); BuildSpec v4.3 §09; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 432 | Subscription/large annual charge tracker (pattern-based alerts) | Auto-renewing software/insurance/annual fees not in AP. MD9 note: overlaps prepaid predictor | Audit #432 (Cat 23); BuildSpec v4.3 §25; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| S-0093 | Bills screen: AI suggestions for GL/job/department; missing W-9/expired COI warning badge preventing inadvertent processing; line-item detail; vendors at 95%+ confidence can be set to auto-approve |  | BuildSpec v4.3 §09 |  |
| S-0094 | Subscription tracker: surface auto-renewing software, insurance, annual fees not in AP queue; pattern-based alerts |  | BuildSpec v4.3 §25 #7 | v3.1 approved |
| S-0095 | AI bill parsing pipeline + manual upload path |  | MD9 IV.1 | BUILT |
| S-0096 | 11b Procurement: requisition → approval → PO → receiving → 3-way match; commitment/encumbrance accounting | High priority for construction companies | MD9 GATE 11b | OPEN |
| S-0097 | Vendor credit memo reduces future payable; vendor cash refund; AI matches credit to original bill/vendor |  | Posting Engine Spec B1 |  |
| S-0098 | Sales/use tax on bills posted to tax-payable account (not dumped into expense) |  | Posting Engine Spec B1, E6 |  |
| S-0099 | AP approval routing configurable: direct, by vendor, by GL code, by transaction, overridable; project manager/leader can be an approver destination | Approval is Books-side | Event Contract §1, §6 |  |
| S-0100 | Bills list: vendor compliance cross-check (W-9/COI), due-date aging (overdue red, due soon amber), payment holds surfaced where payment decisions are made |  | Handoff S8 §1, §5 | BUILT S8 |
| S-0101 | AI bill parsing from PDF or image: extracts all fields, matches vendor, detects duplicates; original document shown beside form; per-field confidence badge (green ≥85, amber ≥60, red <60); duplicate + vendor compliance warnings; drag/drop upload or manual entry |  | Handoff S10 §1, §5 | BUILT S10 |
| S-0102 | Bill posting and payment templates | Bill: DR Expense (or Asset) / CR AP (+ sales/use tax). Pay: DR AP / CR Cash | [H] D20 | Canon |
| S-0103 | GATE 4: M365 / Graph email ingestion | Hourly; Azure OAuth2 per org; Graph Mail.ReadWrite | [H] D40 Part VII, Part IX | BLOCKED on Azure creds |
| S-0104 | AP inbox pipeline (marquee) | Email → extract → vendor auto-create → bill PENDING or ON_HOLD by tier → attach source → exception queue | [H] S39 §5; S40 §5; S41 §5 | Top pipeline priority; partly built |
| S-0105 | "Auto-file invoice" upload intake | Upload → AI extract → vendor resolve-or-create → PENDING / ON_HOLD bill + lines; never posts to GL | [H] S39 §8 | Built |
| S-0106 | Provider-agnostic AP document intake queue | Ready for Azure | [H] S44 §2 | Built; awaits GATE 4 |
| S-0107 | AP inbound email-to-bill webhook | `/api/webhooks/inbound-email`, shared-secret auth, tenant matched by `inbound_ap_address`; stores the attachment + a PENDING_PARSE draft even when AI is down | [H] S48 §2 (mig 135) | Built (per org, not per company) |
| S-0108 | Source-document retention | Uploaded file stored in the private `documents` bucket before the AI step; linked to the record's Attachments panel | [H] S48 §2 (mig 112) | Built |
| S-0109 | AP line-coding fallback | Unresolved lines go to 6660 Misc OPEX; human re-codes on approval | [H] S39 §8; S40 §4 | Known behavior |
| S-0110 | Bill anomaly detector (BILL_ANOMALY) | Vendor price/quantity variance, first-time-large, round dollar before posting | [H] S42 §2 | Built (detect-only) |
| S-0111 | AP policy engine | Reusable policy primitive applied to bill approval | [H] S45 §2 | Built |
| S-0112 | Purchase orders + goods receipts + 3-way match | PO ↔ receipt ↔ bill | [H] S44 §2 (mig 080); ANCHOR §5 | GATE 11b DEPTH built |
| S-0113 | NL draft-bill lane (P3) | Plain-English bill draft; propose → approve | [H] S43 §2 | Built; AI currently down |
| S-0114 | AP-intake agent loop (M9) | First recipe on the supervised agent runner | [H] S46 §2 | Built |
| S-0115 | Pay run + remittance advice | Remittance document + PDF, vendor payment detail view | [H] S49 §2 (mig 137) | Built |
| S-0116 | AP money-out MVP | Disbursement batch + NACHA/CSV export + human release | [H] S46 §5 | In flight at S46; covered by S49/S50 builds |
| S-0117 | Bill received-at timestamp | Feeds cycle-time KPIs | [H] S42 (mig 074) | Built |
| S-0118 | Prepaid expenses | Buy: DR Prepaid / CR Cash or AP. Amortize each period | [H] D20 | Canon; schedule engine built |
| S-0119 | Period-end accrued expense | DR Expense / CR Accrued Liabilities; reverses next period | [H] D20 | Canon |
| S-0120 | AP inbox: bill extraction from email/PDF with side-by-side review | Extract vendor, invoice #, date, due date, amount, terms, GL and job. Show the extracted fields next to the source image. On confirm it becomes a draft bill pending approval to pay; the source doc stays attached. A2 / CORE-2. | [D1] CATv1 A2; BKP CORE-2; CFO #1 | 3.95; Gate 4 (blocked on Azure creds) |
| S-0121 | Line-level PDF/image invoice extraction | Vendor, inv#, dates, terms, subtotal/tax/freight/total and line items; side-by-side extracted-vs-source review; creates PENDING/ON_HOLD draft bill; job-site phone photos are an intake channel (AP A1) | [D1] CATv2 AP-A1; [D2] AP Group A; P2P S1 M1 | High 3.95; partial; Top30 #17; PARTIAL (no source retained, no line-level GL, no vendor contact fields); AP rank #4 (Gate 8) |
| S-0122 | Email AP inbox ingestion (bills@tenant) | Watches a dedicated mailbox (M365/Graph); each inbound invoice email → extraction; email thread becomes context and audit source (AP A2) | [D1] CATv2 AP-A2; INT §2.5; [D2] AP Group A | High 3.90; blocked (Gate 4); GAP / BLOCKED (GATE 4, Azure creds) |
| S-0123 | Per-entity AP inbox agent | Per-entity inbox; vendor replies drafted from live data; vendor email threads attached to the bill; bank-detail-change fraud detection | [D1] GAP §3B #14 | T2; partial (webhook + fraud detector, no mail provider) |
| S-0124 | Bills from texted job-site photos and vendor portals | Multi-channel intake (PDF, photo, portal, paper) | [D1] BKP Part 1; CFO Part 1 | — |
| S-0125 | Source-document vault plus provenance | Prerequisite for audit-grade extraction. AP-A3. | [D1] CATv2 AP-A3; [D2] AP Group A | High 3.85; none; Top30 #17; GAP (no storage bucket); AP rank #4 |
| S-0126 | Vendor-portal / EDI invoice fetch | Logs into vendor portals or accepts EDI 810 to pull invoices no human downloads (AP A4) | [D1] CATv2 AP-A4; [D2] AP Group A | Med 2.90; none; GAP |
| S-0127 | Duplicate-at-intake block | Inline check before the bill is saved. AP-A5. | [D1] CATv2 AP-A5 | High 4.00; partial; Top30 #3 |
| S-0128 | Duplicate and erroneous payment detection | Fuzzy match on invoice # + vendor + amount + date against all prior payments and the feed. Blocking warning shows both records; user chooses merge / discard as duplicate / genuinely different. Never auto-deletes. Fallback is an exact invoice # + amount block. Estimated loss avoided: $50k–$250k/yr on $50M of AP. B1 / AP-D5 / EC-1. | [D1] CATv1 B1; CATv2 AP-D5; BKP CORE-3; CFO #1; MGR B4; [D2] AP Group D; BC Group E; GLC 1.5 #1 | Crit 4.60; built detect-only → blocking gate is Top30 #3 / v2-BN #3; BUILT detect-only; BC Tier 3 #8 (promote to blocking) |
| S-0129 | Line-level AP auto-coding from vendor history | GL + dept/location/class from the vendor's learned map; one-click/batch approve; lowest-confidence first (AP C1) | [D1] CATv2 AP-C1; [D2] AP Group C; P2P S1 M2/M14 | High 3.95; partial; Top30 #17; PARTIAL (bill lines fall back to vendor default / 6660); AP rank #5 (Gate 6) |
| S-0130 | Cost → job/cost-code attribution with JOB_COST emit | The suite moat (Books → Projects). AP-C2. | [D1] CATv2 AP-C2 | Crit 4.05; partial; Top30 #17 |
| S-0131 | Tax-character tagging at AP posting | Feeds book-to-tax (TX-C1). AP-C4. | [D1] CATv2 AP-C4 | High 3.60; none |
| S-0132 | PO model in Books | Adds `bills.purchase_order_id`. Keystone for 3-way match, encumbrance and RNI auto-draft. Needs a central (shared-spine) table. AP-D1. | [D1] CATv2 AP-D1 | Crit 4.10; none; Top30 #10; Gate 11b |
| S-0133 | 2-way match / PO-variance flag | AP-D3 | [D1] CATv2 AP-D3; [D2] AP Group D; P2P S9 M3 | High 3.60; none; GAP; AP rank #2 |
| S-0134 | Bill vs job budget / committed-cost check | Over-budget bills get a human flag before they post | [D1] BKP Part 1 (9:00) | — |
| S-0135 | Bill-amount anomaly detection (no PO needed) | AP-D4 / BILL_ANOMALY detector | [D1] CATv2 AP-D4; [D2] AP Group D; P2P S1 M4 | High 3.70; built; BUILT (`bill-anomaly.ts`) |
| S-0136 | Math/foot validation at entry | Lines sum to subtotal, tax/freight reconcile, total foots; block on mismatch (AP D6) | [D1] CATv2 AP-D6; BKP Part 1; [D2] AP Group D | Med 3.10; none; GAP |
| S-0137 | Bill approval routing by amount / type / cost center | AP-E1 | [D1] CATv2 AP-E1; [D2] AP Group E | High 3.40; partial; PARTIAL; AP rank #7 (Gate 11e + 9) |
| S-0138 | Approval SLA / aging nudges | Protects early-pay discounts. AP-E3. | [D1] CATv2 AP-E3; [D2] AP Group E; P2P S1 M11 | Med 3.05; none; GAP (`received_at` stamped only); AP rank #7 |
| S-0139 | Recurring bill templates | AP-H3 | [D1] CATv2 AP-H3; [D2] AP Group H | Med 3.05; none; PARTIAL (AR side only, mig 073) |
| S-0140 | Received-not-invoiced (RNI) and recurring accruals auto-drafted from open POs | AP-H1 | [D1] CATv2 AP-H1; CFO #3; [D2] AP Group H | High 3.65; partial; PARTIAL (detect via missed-accruals; auto-draft needs D1) |
| S-0141 | Vendor-statement reconciliation | Catches lost invoices and credit leaks. AP-G2. | [D1] CATv2 AP-G2; [D2] AP Group G | High 3.35; none; GAP; AP rank #9 |
| S-0142 | Spend analytics and vendor concentration | AP-I4 | [D1] CATv2 AP-I4 | Med 2.95; partial |
| S-0143 | Contract/subscription renewal tracking | Renewal dates, auto-renew traps, price increases, unused seats; alert before renewal (AP I5) | [D1] CATv2 AP-I5; [D2] AP Group I; P2P S1 M12 | Med 2.90; none; GAP / spec |
| S-0144 | Retainage withholding on subcontractor bills | AP-F6 | [D1] CATv2 AP-F6; [D2] AP Group F | Med 3.10; built; BUILT (mig 036, `services/retainage`) |
| S-0145 | Lien waivers gated to payment | Construction/trades | [D1] GAP §3C #22 | T2–3; missing |
| S-0146 | PO / goods-receipt OCR | NEW-PO1 | [D1] CATv2 §6.2; MATRIX §3c | Crit (theme); none |
| S-0147 | PO-line commodity / cost-code coding | Classification | [D1] CATv2 §6.2; [D2] P2P S9 M2 | none; NONE ⭐NEW |
| S-0148 | Maverick / split-PO threshold-dodge detection | Detection | [D1] CATv2 §6.2; [D2] P2P S9 M4; AP Stage 0/5 | none; NONE ⭐NEW |
| S-0149 | Commitment / encumbrance forecast | NEW-PO4 | [D1] CATv2 §6.2 | none |
| S-0150 | PO / RFQ draft generation | NEW-PO5 | [D1] CATv2 §6.2; [D2] P2P S9 M6 | none; NONE ⭐NEW |
| S-0151 | Sourcing / contract-price-compliance optimization | NEW-PO6 | [D1] CATv2 §6.2 | none |
| S-0152 | Encumbrance-vs-budget and receiving-overdue alerts | NEW-PO7 | [D1] CATv2 §6.2 | none |
| S-0153 | AP subledger and aging owned by MeritBooks (not Ramp) | Ownership split: Ramp holds spend rails; Books holds the AP subledger, accruals and 1099 consolidation | [D1] GAP §2 | T1 context |
| S-0154 | Duplicate-at-intake inline guard | Fuzzy vendor + inv# + amount + date at bill create; blocking "looks like bill #X"; never auto-deletes (AP A5) | [D2] AP Group A; P2P S1 M3 | PARTIAL (EC-1 post-hoc only) |
| S-0155 | Cost → job + cost-code attribution on bill lines (suite moat) | Proposes job/cost code from vendor, PO/commitment and open budget lines; emits `JOB_COST` event to Projects; commitment-vs-actual classification (AP C2) | [D2] AP Group C; FTP §6 M2; P2P S1 | PARTIAL (seam exists; AI suggestion not built); AP rank #5; "the differentiator" |
| S-0156 | Purchase-order model in Books | First-class PO/commitment header + lines; `bills.purchase_order_id`; Books reads `proj.commitments` (AP D1) | [D2] AP Group D; P2P S9 | NEEDS-CENTRAL; keystone; AP rank #1 (Gate 11b) |
| S-0157 | Uncategorized / "Ask My Accountant" cleanup (AP side) | Re-proposes coding for parked bills/lines as context arrives; gates close on an empty queue (AP I7) | [D2] AP Group I | PARTIAL (`uncategorized-leakage.ts`) |
| S-0158 | Per-bill coding / flag rationale | "Why 5040 + this job; why flagged duplicate" shown at review | [D2] P2P S1 M7 | NONE ⭐NEW |
| S-0159 | NL AP query/command | "Unpaid bills >30d for Acme; schedule the discount-eligible ones" | [D2] P2P S1 M8 | NONE ⭐NEW |
| S-0160 | PO / quote / goods-receipt document extraction | Receiving OCR distinct from invoice OCR | [D2] P2P S9 M1 | NONE ⭐NEW |
| S-0161 | PO-variance narrative | e.g. "12% over PO; qty 120 vs 100; $12 vs $10" | [D2] P2P S9 M7 | NONE ⭐NEW |
| S-0162 | NL procurement command | "Raise a PO to Acme for 100 units at contract price against job 7" | [D2] P2P S9 M8 | NONE ⭐NEW |
| S-0163 | Sourcing / vendor selection + contract-price compliance | Optimization | [D2] P2P S9 M11 | NONE ⭐NEW |
| S-0164 | Over-commitment / encumbrance-vs-budget + receiving-overdue alerting | Alerts | [D2] P2P S9 M12 | NONE ⭐NEW |
| S-0165 | Catalog / contract-price retrieval (punchout-style) | Contracted price and lead time | [D2] P2P S9 M13 | NONE ⭐NEW |
| S-0166 | Learned PO coding / preferred vendor per commodity | Learning | [D2] P2P S9 M14 | NONE ⭐NEW |

## Vendor management & W-9/COI chase

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 239 | Vendor Directory — AI-learned defaults (GL, job, auto-approve at 95%+) | MD9 note: full CRUD; wire default GL/job + auto-approve | Audit #239 (Cat 11); BuildSpec v4.3 §14; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅/🔶; seq P5-LOWER |
| 240 | Vendor compliance — W-9 tracking (no expiration) | MD9 note: vendor_compliance_docs | Audit #240 (Cat 11); BuildSpec v4.3 §14; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ⬜; seq P5-LOWER |
| 241 | Vendor compliance — GL COI tracking (annual) | MD9 note: vendor_compliance_docs | Audit #241 (Cat 11); BuildSpec v4.3 §14; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ⬜; seq P5-LOWER |
| 242 | Vendor compliance — WC COI tracking (annual) | MD9 note: vendor_compliance_docs | Audit #242 (Cat 11); BuildSpec v4.3 §14; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ⬜; seq P5-LOWER |
| 243 | Vendor compliance — WC Exemption tracking | MD9 note: vendor_compliance_docs | Audit #243 (Cat 11); BuildSpec v4.3 §14; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ⬜; seq P5-LOWER |
| 244 | Missing/expired docs trigger automatic payment holds | Missing/expired docs auto-hold payments. MD9 note: vendor_payment_holds | Audit #244 (Cat 11); BuildSpec v4.3 §14; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ⬜; seq P5-LOWER |
| 245 | Auto-chase: reminders every 2 weeks from 60 days, then weekly | Every 2 weeks from 60 days before expiry, then weekly | Audit #245 (Cat 11); BuildSpec v4.3 §14; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P5-LOWER |
| 246 | Organization-level outreach (one doc covers all 17 companies) | One document covers all of the tenant's companies | Audit #246 (Cat 11); BuildSpec v4.3 §14; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P5-LOWER |
| 247 | Self-service vendor portal via magic link | Vendor uploads via magic link, no account. Spec: Magic link; vendor uploads W-9 / COI / banking → PENDING review, never auto-approved; type/size checked | Audit #247 (Cat 11); BuildSpec v4.3 §14; MD9 Part V; [H] S50 §2 (mig 142) | Apr-26 audit: MISSING; MD9: ❌; seq P5-LOWER; Built |
| 248 | Claude auto-parses uploaded compliance documents | Claude parses W-9/COI uploads | Audit #248 (Cat 11); BuildSpec v4.3 §14; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P5-LOWER |
| 249 | Payment hold overrides — one-time, temporary, permanent | One-time / temporary (date range) / permanent; reason required; Acct Mgr+. MD9 note: enum | Audit #249 (Cat 11); BuildSpec v4.3 §14; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ⬜; seq P5-LOWER |
| 250 | All payment hold overrides audit-logged |  | Audit #250 (Cat 11); BuildSpec v4.3 §14; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P5-LOWER |
| S-0167 | Vendor directory columns: default GL, default job, companies using vendor, transaction count, YTD spend, 1099 flag, AI confidence % |  | BuildSpec v4.3 §14 |  |
| S-0168 | WC Exemption tracked per state rules |  | BuildSpec v4.3 §14 |  |
| S-0169 | Payment hold overrides require documented reason; only Accounting Manager+ may create |  | BuildSpec v4.3 §14 |  |
| S-0170 | Daily vendor compliance scan for COI expirations within 60 days; send chase reminders per schedule |  | BuildSpec v4.3 §19 |  |
| S-0171 | Vendor-compliance pay-time payment-hold gate in bill payment + override lifecycle + chase maintenance + audit events; /vendor-compliance page; follow-up: required-docs-per-vendor config | Fails open | MD9 XI.9 (mig 037) | BUILT |
| S-0172 | Vendor creation form (incl. inline from bill flow); customer creation form (incl. inline from invoice flow); duplicate detection | Blockers in S10 | Handoff S10 §4, §6 | Built S11 |
| S-0173 | Vendor compliance policy | W-9 / COI / workers' comp; missing doc → automatic payment hold; chase every 2 weeks starting 60 days before expiry; magic-link upload; Claude parses; one-time / temporary / permanent overrides, audit-logged | [H] D40 Part VIII | Canon; auto-chase in GATE 8 (OPEN) |
| S-0174 | Vendor compliance risk engine | Scores each vendor on worst COI/W-9 state + open AP exposure; tiers; escalates high-risk on-hold vendors to /exceptions | [H] S40 §2 | Built |
| S-0175 | Dedicated "Vendor compliance" exception source | Deep link to /vendor-compliance | [H] S40 §4 | Optional / open |
| S-0176 | Vendor ledger drawer | Open bills, payment history, YTD/TTM spend, W-9/COI status, hold state | [H] S42 §2 | Built |
| S-0177 | Vendor 360 | Deeper drawer; raw `tin_encrypted` removed from the API (PII) | [H] S49 §2 | Built |
| S-0178 | Duplicate-vendor detection | Read-only, on the vendor 360; EC-1 also flags duplicate vendor records | [H] S46 §2; S41 §2 | Built |
| S-0179 | Provisional vendors | A vendor created by Projects starts with W-9 missing / unapproved until Books clears it | [H] D10 Matrix rule C | Canon |
| S-0180 | Books-owned vendor fields | Default account / class / department, is_1099, TIN, W-9 status, payment terms, hold | [H] D10 core.vendors | Canon |
| S-0181 | Vendor payment profiles | Used by the pay run | [H] S49 (mig 137) | Built |
| S-0182 | Vendor auto-create from an invoice | AI drafts the vendor record; a human approves it before it is real. AP-B1 / CORE-4. | [D1] CATv2 AP-B1; BKP CORE-4; [D2] AP Group B | Med 3.10; partial; PARTIAL (name only) |
| S-0183 | W-9 / TIN capture plus payment gate | Required at vendor create and first payment. Auto-chase and reminders. Pay-anyway override is logged. AP-B2 / B2. | [D1] CATv2 AP-B2; CATv1 B2; CPA B4 | High 3.90; partial (engine built Session 40) |
| S-0184 | COI (general liability + workers' comp) tracking with expiry chase | GL and WC COIs + WC exemption; computed payment hold; escalating reminders (weekly if expired/≤14 days, otherwise biweekly); override ONE_TIME/TEMPORARY/PERMANENT with reason; grant/consume/release audited (AP B3) | [D1] CATv2 AP-B3; BKP CORE-4; CFO #11; [D2] AP Group B; P2P S2 M6/M12; GLC K1 | High 3.90; built (send blocked on Gate 4); BUILT (mig 037); chase email not sent (GATE 4) |
| S-0185 | Vendor compliance badge | Shows missing W-9 / COI expired; flags the vendor and gates payment; escalations go to the exceptions queue | [D1] BKP CORE-4 | built (engine) |
| S-0186 | BEC / vendor bank-change verification | New or changed bank details are quarantined, require dual control and human release, and are never auto-paid. AP-B4 = BC-E2. | [D1] CATv2 AP-B4, BC-E2; CFO #1; MGR A6; [D2] AP Group B; BC Group E; P2P S2 M4 | Crit 4.10; none; Top30 #3; GAP; AP rank #3 (Gate 9); BC Tier 3 #7; "#1 dollar-loss AP fraud" |
| S-0187 | Duplicate vendor-master detection and merge proposal | Matches on name / EIN / bank / remit address. AP-B5. Also needs surfacing in the vendor UI. | [D1] CATv2 AP-B5; COV #19; [D2] AP Group B; P2P S2 M3 | High 3.60; built (UI gap); BUILT (EC-1 rule C) |
| S-0188 | Vendor sanctions / OFAC screening | AP-B6, plus continuous re-screen (NEW-VN3) | [D1] CATv2 AP-B6, §6.2 | Med 2.85; none |
| S-0189 | Vendor reliability / delivery-risk score | NEW-VN1 | [D1] CATv2 §6.2; [D2] P2P S2 M5 | Med; none; NONE ⭐NEW |
| S-0190 | Vendor consolidation / preferred-vendor recommendation | NEW-VN2 | [D1] CATv2 §6.2; [D2] P2P S2 M11 | Med; none; NONE ⭐NEW |
| S-0191 | Subcontractor compliance pack | COI and W-9 exist; lien waivers missing | [D1] GAP §3C #22 | partial |
| S-0192 | Vendor-compliance status readout | e.g. "Payable-blocked: WC COI lapsed 8d, W-9 present" | [D1] MATRIX §2; [D2] P2P S2 M7 | none; partial ⭐NEW |
| S-0193 | W-9 collection at onboarding + W-9/COI field extraction | W-9 required before first payment; TIN format validation; entity type drives 1099-reportability; extract TIN/entity type/coverage/expiry (AP B2, TAX B1) | [D2] AP Group B; TAX Group B; P2P S2 M1; FTP §3 M1 | W-9 doc + hold BUILT; field extraction NOT built; AP rank #8 |
| S-0194 | Compliance-hold payment gate | Blocks payment to non-compliant vendors (missing/expired W-9/COI) unless an active override; consumes ONE_TIME overrides; audited (AP F5, TAX B1) | [D2] AP Group F; TAX Group B; P2P S2 M10 | BUILT (`enforcePaymentAllowed`) |
| S-0195 | OFAC / sanctions / watchlist screen + continuous re-screen | Screens new vendors against OFAC/denied-party lists + "is this a real business" heuristic; periodic re-screen (AP B6) | [D2] AP Group B; P2P S2 M4/M12 | GAP / spec |
| S-0196 | Vendor classification | 1099-reportability, entity type, related-party, sub vs supplier | [D2] P2P S2 M2 | partial |
| S-0197 | NL vendor query | "Which subs are uninsured / missing W-9 / over 10% of spend" | [D2] P2P S2 M8 | NONE ⭐NEW |
| S-0198 | Vendor-360 / contract knowledge retrieval | Docs, banking history, prior disputes, related entities, terms on file, last 3 invoices, "is this in-contract" | [D2] P2P S1 M13, S2 M13 | NONE ⭐NEW |
| S-0199 | Vendor-master enrichment memory | Learned remit-to, contacts, normalized name | [D2] P2P S2 M14 | NONE ⭐NEW |

## Check processing (print, positive pay, mailing)

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 37 | Bill payment via check | Pay bills by printed check (via Check Management queue). MD9 note: needs Check Mgmt (Phase 3) | Audit #37 (Cat 2); BuildSpec v4.3 §04 AP; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶; seq P2-HIGH |
| 48 | Positive pay file generation for bank fraud protection | Positive pay issue file (check #, amount, payee, date) generated when checks print. MD9 note: with Check Mgmt | Audit #48 (Cat 2); BuildSpec v4.3 §04 AP; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 200 | Check Management — Print Queue (batch select + print) | Batch select approved checks + print (Check Processor role only). MD9 note: needed for NL “queue check” | Audit #200 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 201 | Check Management — Check History (printed/cleared/void/stale) | Printed / cleared / void / stale with search. MD9 note: needed for NL “queue check” | Audit #201 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 202 | Check Management — Positive Pay (bank exception matching) | Bank exception matching, approve/reject per exception. MD9 note: needed for NL “queue check” | Audit #202 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| S-0200 | Check Management: accountants approve bills into print queue; Check Processor (non-accountant) batch-selects, prints physical checks AND generates positive pay file in a single action | Separation of duties by design | BuildSpec v4.3 §10, §17 |  |
| S-0201 | Positive pay issue file contents: check numbers, amounts, payees, dates; Positive Pay tab with bank exception matching and approve/reject per exception |  | BuildSpec v4.3 §10 |  |
| S-0202 | Check Processor role | A separation-of-duties role | [H] D20 roles | Canon |
| S-0203 | Check Run | Queues due bills for approval; prepare + approve only; never releases or posts. `/checks` approve button works | [H] S40 §2; [D1] CATv2 AP-F1; INT §2.1; [D2] AP Group F; P2P S7 M9 | Built; High 3.50; built; BUILT (`api/checks/run`) |
| S-0204 | Check-run permission split | `check_processor` regains check run without payroll release; granular `check_run` key | [H] S44 §4 (task #56); S48 §2 | Done in S48 (ANCHOR §6 still lists it as open) |
| S-0205 | Check-number assignment | `/api/ap/disbursements/check-numbers` | [H] S49 §2 | Built |
| S-0206 | Positive-pay file export | Issued-check file with check #, payee, amount, issue date and void flag, sent on each check run via SFTP/API. Bank exception report ingested back; AI reconciles it. AP-F4 = BC-E3/E4. | [D1] CATv2 AP-F4; INT §2.1 | High 3.35; none |
| S-0207 | Morning positive-pay exception clearing | Done against the bank's daily deadline | [D1] CFO Part 1 | — |
| S-0208 | Stale / uncleared check aging and surfacing | AP-G1; BC-B10 | [D1] CATv2 AP-G1, BC-B10 | Med 3.20; partial |
| S-0209 | Positive-pay issued-check file | Generates the bank issued-check register file so the bank blocks altered/forged items (AP F4, BC E3) | [D2] AP Group F; BC Group E | GAP; BC: segment-specific (check-issuing tenants) |
| S-0210 | Positive-pay exception adjudication before bank cutoff | Ingests the bank exception list (payee/amount/serial mismatch); pay/return each item before the ~10–11am deadline (BC E3) | [D2] BC Part 1.1, Group E | MISSING |
| S-0211 | Stale / uncashed outstanding-check aging | Surfaces escheatment/void candidates (BC B10, F5) | [D2] BC Group B/F; AP G1 | MISSING (part of rec report) |

## Payments / ACH / money movement

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 38 | Bill payment via ACH |  | Audit #38 (Cat 2); BuildSpec v4.3 §04 AP; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 39 | Bill payment via virtual card |  | Audit #39 (Cat 2); BuildSpec v4.3 §04 AP; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 40 | Batch payment processing | Pay many bills in one batch run | Audit #40 (Cat 2); BuildSpec v4.3 §04 AP; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 41 | Payment scheduling | Schedule payment dates | Audit #41 (Cat 2); BuildSpec v4.3 §04 AP; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 42 | Early payment discount tracking (2/10 net 30) | Track early-pay discounts (2/10 net 30) | Audit #42 (Cat 2); BuildSpec v4.3 §04 AP; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 82 | Fund transfers between accounts/entities | Transfers between accounts/entities | Audit #82 (Cat 4); BuildSpec v4.3 §04 Banking, §06; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH |
| S-0212 | Stripe Connect AR collection: Express connected account per tenant, onboarding link + status in Payments settings, destination charges with application fee, webhook → payment applied → AR collection GL post | Fees card 3% flat, ACH 1% uncapped (QBO default) | MD9 GATE 12.1 | BUILT (PAID-flip verified later) |
| S-0213 | Approve-by-exception payments: pre-vet against budget/contract/compliance/duplicate/fraud; only exceptions go to a human |  | MD9 GATE 5 | OPEN |
| S-0214 | Money movement principle: MeritBooks never the regulated party; licensed providers behind swappable interfaces (ArProcessor/ApDisburser/PayrollEngine/BankFeed); no automated transfers (explicit human release); preparer≠approver (DB CHECK); no raw credentials (Vault); entitlement-gated; float via clearing accounts; idempotent; audit with provider correlation id |  | MD9 GATE 12 | Guardrails |
| S-0215 | Money-movement approval state machine DRAFT→PENDING_APPROVAL→APPROVED→RELEASED→SETTLED / REJECTED / RETURNED |  | MD9 XI.10 (mig 042) | BUILT |
| S-0216 | AP disbursement GL: release DR AP / CR Payments in Transit; settlement DR in-transit / CR bank; return/NSF; void | Adapter not built; AP is bring-your-own-bank per tenant; embedded-AP (Melio-style) leading, Modern Treasury alternative | MD9 GATE 12.2 | GL layer BUILT |
| S-0217 | ACH authorizations stored durably in Books (masks only) |  | MD9 XI.10 (mig 043) | BUILT |
| S-0218 | Card issuing | Optional | MD9 GATE 12.4 | DEFERRED |
| S-0219 | ACH/NACHA authorizations kept as durable Books-owned compliance records |  | Suite Architecture §3B.6 |  |
| S-0220 | Card surcharge options: card pass-through (customer pays base + 3%, explicit fee-acceptance checkbox, "+3% fee" badge) or absorbed; ACH 1% borne by merchant (QBO default); invoice total immutable |  | Handoff S37 §3, §5 | BUILT |
| S-0221 | GL for collected payment: DR Settlement Clearing (net), DR Merchant Fee Expense (fee), CR AR (base); webhook idempotency on Stripe event id; payment dedupe on PaymentIntent id |  | Handoff S37 §3 | BUILT |
| S-0222 | Pay Now method cards with timing labels (card "Confirms instantly", ACH "Clears in 1–2 business days"); ACH via Stripe Financial Connections; return banner succeeded/processing/failed; payer prefill from customer record |  | Handoff S37 §5 | BUILT |
| S-0223 | White-label Stripe onboarding via embedded components (tenants never see Stripe branding); interchange-plus processor pivot at ~$10M+/yr volume |  | Handoff S37 §4 | Future polish |
| S-0224 | Go-live: live Stripe keys, platform legal entity, live statement descriptor in Merit Enterprise Suite brand |  | Handoff S37 §4 |  |
| S-0225 | GATE 12 principle: never the regulated party | A licensed provider moves the money; MeritBooks owns GL / reconciliation / approval / audit / UI; each provider sits behind an interface | [H] D40 Part VII GATE 12 | Canon |
| S-0226 | Money-movement guardrails | No automated transfers (explicit human release); preparer ≠ approver (server + DB CHECK); no raw credentials (Vault); gated by entitlements; clearing accounts for float; idempotent origination and webhooks | [H] D40 Part VII; D10 Provider Connections | Canon |
| S-0227 | Authorization tied to core identity | Must reconcile to `core.memberships`; audit actor / before-after / provider correlation id | [H] D10; ANCHOR §3 | Canon; built S41 |
| S-0228 | AP disbursement (12.2) | Bank-your-own-bank per tenant; embedded AP (Melio-style) is the leading option | [H] D40 Part VII 12.2 | GL posting done; adapter → S50 rail |
| S-0229 | ACH / wire origination rail | Provider-agnostic interface + SANDBOX adapter; batch/item lifecycle (CREATED → SUBMITTED → SETTLED / RETURNED) with ACH return codes; posts nothing to GL | [H] S50 §2 (mig 143); [D1] INT §2.1, §3 F2, §4 #4 | Built to credential boundary; needs a live originator; spec (interface only) |
| S-0230 | Clearing accounts | 1095 Payment Processor Clearing; 1096 Payments in Transit | [H] D40 Part III (mig 043) | Built |
| S-0231 | Payment-run fraud screen | New payee, business-email-compromise bank change, unusual amount, duplicate; blocks a duplicate payment; human override | [H] S43 §2; S44; [D1] CATv2 §6.2; MATRIX §3c; [D2] P2P S7 M4 | Built (detect-only); Crit; none; Top30 #16; partial ⭐NEW; "highest-value miss" |
| S-0232 | Granular money permissions | `payments_execute`, `check_run`, `ap_disbursement_release`, `payroll_release`; editable in /settings/roles | [H] S44 §2; S48 §2 | Built |
| S-0233 | Database blocks double payment | Unique indexes on money-in (mig 064) and money-out (mig 113) | [H] S41; S48 | Built |
| S-0234 | Go-live swap | Test keys → live keys, confirm the legal operating entity, live statement descriptor in Merit Enterprise Suite branding | [H] S38 §4 #8 | Open (human) |
| S-0235 | Multi-rail disbursement with correct rail accounting | AP-F3 | [D1] CATv2 AP-F3 | High 3.40; partial |
| S-0236 | Payment-timing / dynamic-discount optimizer | 2/10 net 30 ≈ 36% annualized. AP-F2. | [D1] CATv2 AP-F2; [D2] AP Group F; P2P S1 M5 | High 3.45; none; GAP; AP rank #6 (Gate 8) |
| S-0237 | Compliance-hold payment gate | AP-F5 | [D1] CATv2 AP-F5 | High 3.60; built |
| S-0238 | Payment-rail classification | NEW-MM1 | [D1] CATv2 §6.2; [D2] P2P S7 M2 | none; partial ⭐NEW |
| S-0239 | Settlement-date prediction | NEW-MM3 | [D1] CATv2 §6.2; [D2] P2P S7 M5 | none; NONE ⭐NEW |
| S-0240 | Remittance-advice and payment-confirmation generation | What was paid and which invoices, on AP payment or any money-out | [D1] CATv2 §6.2; [D2] P2P S1 M6, S7 M6 | none; Top30 #16; NONE ⭐NEW; "highest-value miss" pair |
| S-0241 | Rail optimization | Cheapest/fastest rail; virtual-card rebate. NEW-MM5. | [D1] CATv2 §6.2; [D2] P2P S7 M11 | none; NONE ⭐NEW |
| S-0242 | Payment-status / failed-payment monitoring | NEW-MM6 | [D1] CATv2 §6.2; [D2] P2P S7 M12 | none; NONE ⭐NEW |
| S-0243 | Money-movement SoD with explicit human release | Preparer ≠ approver ≠ releaser, enforced in the database. AI never initiates a transfer. | [D1] CFO #6/#10; MGR B6; CATv1 E2 | built (Gate 12.1) |
| S-0244 | Ramp bill-pay rails | Recommended ownership: Ramp owns bill-pay rails, cards and procurement/POs | [D1] GAP §2 | T1 decision |
| S-0245 | Multi-rail disbursement (check / ACH / wire / virtual card) | Executes the approved payment on the chosen rail; correct cash-side account (credit card → Credit Card Payable, not cash); captures wire/card fees; deterministic GL post (AP F3) | [D2] AP Group F | PARTIAL (posting engine + rail→account built; outbound rails not integrated) |
| S-0246 | Money-movement SoD (preparer ≠ approver ≠ releaser, incl. AI) | DB CHECK + service; explicit human release; AI proposer can never release; every step attributed (BC E8, GLC J4) | [D2] BC Group E; GLC Group J; P2P S7 M10 | BUILT (mig 042/043); RBAC reconcile open (gate #9/#33) |
| S-0247 | ACH debit filter / unauthorized-debit detection | Allowed-originator list; flags debits from unapproved originators (BC E4) | [D2] BC Group E | MISSING; segment-specific |
| S-0248 | Payment cash-impact narrative | e.g. "This run clears $84k across 12 vendors; low-water Wk3" | [D2] P2P S7 M7 | NONE ⭐NEW |
| S-0249 | NL pay command | "Release the approved discount-eligible bills under $10k from Ops" (human release) | [D2] P2P S7 M8 | NONE ⭐NEW |
| S-0250 | Payment-history retrieval | Every payment to a payee, by rail, with remittance | [D2] P2P S7 M13 | NONE ⭐NEW |
| S-0251 | Learned payment preference per vendor | Preferred rail, remit contact, batch timing | [D2] P2P S7 M14 | NONE ⭐NEW |
| S-0252 | Sweep / idle-cash optimization | Per-account sweepable surplus above minimum + buffer; proposes sweep to a concentration/interest account or revolver paydown; human release only (BC C4) | [D2] BC Group C; P2P S3 M11; FTP §2 M11 | MISSING; BC Tier 4 #10 (Treasury Optimization FPB) |
| S-0253 | Online Pay Now (ACH + card) hosted, correct GL | Stripe destination-charge PaymentIntent to tenant connected account; method cascade; webhook posts balanced JE before status flip; idempotent on event id + PI id (mig 064 UNIQUE); DR Settlement Clearing (net) + DR Merchant Fee Expense / CR AR 1100; manual offline "record payment" parity to confirm (AR C32) | [D2] AR Group F | BUILT & LIVE (GATE 12.1) |
| S-0254 | Two-layer merchant-fee model | Layer 1 = what MeritBooks charges the merchant (`merchant_fee_schedules`, rate + cap/floor). Layer 2 = pass-through vs absorb: card passes through unless off, ACH absorbed unless on. Invoice override honored; invoice `total_cents` never changes (AR C33) | [D2] AR Group F | BUILT (mig 057, `lib/money/fees.ts`) |

## AR / invoicing / collections

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 52 | Invoice creation with line items and dimensional coding | Lines with GL account, job, 4 dimensions; PDF. MD9 note: wired S9; also minted by the JOB_BILLING seam consumer | Audit #52 (Cat 3); BuildSpec v4.3 §04 AR, §21; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅; seq P1-HIGH |
| 53 | Invoice templates (customizable per entity: logo, colors, terms, bank info) | Per entity: logo, colors, terms, bank info; saved templates | Audit #53 (Cat 3); BuildSpec v4.3 §04 AR, §21; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH |
| 54 | Recurring invoices (auto-generate on schedule) |  | Audit #54 (Cat 3); BuildSpec v4.3 §04 AR, §21; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH |
| 55 | Estimates / quotes with estimate-to-invoice conversion | Estimates/quotes convertible to invoices. Spec: DRAFT / SENT / ACCEPTED / DECLINED / EXPIRED; does not post; convert goes through `createInvoice`; double-convert blocked; estimate PDF; win-rate strip | Audit #55 (Cat 3); BuildSpec v4.3 §04 AR, §21; MD9 Part V; [H] S50 §2 (mig 139) | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH; Built |
| 57 | Sales receipts (immediate payment at point of sale) |  | Audit #57 (Cat 3); BuildSpec v4.3 §04 AR, §21; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH |
| 58 | Credit memos, adjustments, and refunds | Credit memos, adjustments, refunds; apply to future invoices or refund | Audit #58 (Cat 3); BuildSpec v4.3 §04 AR, §21; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH |
| 59 | Payment receipt and application (apply to invoices, partial payment) | Apply to specific invoices; partial payments; bank-feed auto-match. MD9 note: wired; customer_payments/payment_applications | Audit #59 (Cat 3); BuildSpec v4.3 §04 AR, §21; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ✅; seq P1-HIGH |
| 60 | Customer deposits / prepayments | Customer deposits/prepayments (→ Deferred Revenue 2410 / Deposits 2420). MD9 note: → deferred-rev predictor (II.5) | Audit #60 (Cat 3); BuildSpec v4.3 §04 AR, §21; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH |
| 61 | Customer statements (generate and send) | Generate and send customer statements | Audit #61 (Cat 3); BuildSpec v4.3 §04 AR, §21; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH |
| 62 | Online payment acceptance (CC, ACH) | Online CC/ACH acceptance (built as Stripe Pay Now) | Audit #62 (Cat 3); BuildSpec v4.3 §04 AR, §21; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH |
| 63 | Automated dunning / collection letters | Automated aging-based dunning letters | Audit #63 (Cat 3); BuildSpec v4.3 §04 AR, §21; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH |
| 64 | Collection case management (assign case owners, notes, activity log) | Case owners, notes, activity log | Audit #64 (Cat 3); BuildSpec v4.3 §04 AR, §21; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH |
| 65 | Customer self-service portal (view invoices, make payments) | Customer portal: view invoices, pay | Audit #65 (Cat 3); BuildSpec v4.3 §04 AR, §21; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH |
| 72 | Customer master file / directory | MD9 note: full CRUD Session 11 | Audit #72 (Cat 3); BuildSpec v4.3 §04 AR, §21; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ✅; seq P1-HIGH |
| S-0255 | Customer invoicing: create/edit/send; lines with GL account, job, dimensions; PDF generation |  | BuildSpec v4.3 §21 | BLOCKER |
| S-0256 | AR aging buckets Current/30/60/90/120+; by customer, company, entity; drill to invoice |  | BuildSpec v4.3 §21 | BLOCKER |
| S-0257 | Payment application with partial payments and bank-feed auto-matching |  | BuildSpec v4.3 §21 | BLOCKER |
| S-0258 | Credit memos applied to future invoices or refunded |  | BuildSpec v4.3 §21 |  |
| S-0259 | Collections: automated aging-based reminders, escalation workflow, notes and activity log per customer |  | BuildSpec v4.3 §21 |  |
| S-0260 | Recurring invoices with configurable terms and amounts |  | BuildSpec v4.3 §21 |  |
| S-0261 | Customer advances default to Deferred Revenue (2410) with "as customer deposit" override to Customer Deposits (2420) |  | MD9 X.1 | Decision locked |
| S-0262 | Invoice product: 5 branded PDF styles, invoice templates + text overrides, branding bucket (logo), invoice types, cascade of payment methods allowed / card surcharge / retainage default from company → customer → job → invoice; invoice event timeline |  | MD9 V.0, mig 050 | PARTIAL (email send not built) |
| S-0263 | Branded hosted pay page + shareable link with Stripe Payment Element ("Pay Now") card/ACH |  | MD9 GATE 12.1 | BUILT |
| S-0264 | Invoice FPB priorities: PDF, send + shareable link, view tracking, credit memos, recurring, late fees, A/R aging/DSO |  | MD9 V.0, XI.12 | Next per MD9 |
| S-0265 | AI cash application: match partial/lumped remittances to open invoices; post on approval; unmatched → review |  | MD9 GATE 8 | OPEN |
| S-0266 | Cash sale / POS: DR Cash or Undeposited Funds / CR Revenue + Sales Tax Payable |  | Posting Engine Spec B2 |  |
| S-0267 | Customer refund / sales returns (contra-revenue) |  | Posting Engine Spec B2 |  |
| S-0268 | Bad debt: allowance method (Allowance for Doubtful Accounts) or direct write-off as per-company policy; AI flags aged receivables as write-off candidates |  | Posting Engine Spec B2 |  |
| S-0269 | Recurring / subscription billing with usage billing and dunning (also needed to sell MeritBooks as SaaS) |  | Posting Engine Spec Part I #7 | BUILD (GATE 8) |
| S-0270 | Projects-originated draws (MILESTONE / PROGRESS / TIME_MATERIALS / DRAW) become Books invoices; Books validates (customer, open period, lines, accounts) and returns rejection reason for PM to fix; posted invoice fixes by credit memo / adjustment / void-and-reissue |  | Event Contract §4 | BUILT |
| S-0271 | Invoice numbering INV-YYYYMMDD-seq; payment application validates total applied ≤ payment and each ≤ invoice balance; PARTIALLY_PAID / PAID statuses; invoice GL post DR AR / CR line revenue; payment DR Cash / CR AR |  | Handoff S9 §3 | BUILT S9 |
| S-0272 | Invoice send-to-client by email + resend + shareable customer link | Mike-flagged invoice depth gap | Handoff S36 §1, §4 | First FPB target |
| S-0273 | Invoice view tracking ("opened N times") and lifecycle beyond status (sent/viewed/reminders) |  | Handoff S36 §1, §4 |  |
| S-0274 | Invoice late fees (automation) |  | Handoff S36 §1, §4 |  |
| S-0275 | Invoice A/R analytics: aging and DSO |  | Handoff S36 §4 |  |
| S-0276 | Issuer-visible "processing" state for in-flight ACH payments (PAY_PROCESSING invoice event) |  | Handoff S37 §4 | Next (S37) |
| S-0277 | Automatic customer invoice email: branded email + PDF attachment + Pay Now button ("the loop-closer"); provider M365 Mail.Send or transactional email |  | Handoff S37 §4, §6 | Next (S37) |
| S-0278 | Invoice events timeline surfaced in the invoice drawer | — | Handoff S37 §4; [H] S38 §4 #6 | ; Backlog |
| S-0279 | Hosted pay page design: tenant logo, per-tenant accent color with auto-contrast header, From/Bill-to/Details, line items, totals, message, remit info, footer |  | Handoff S37 §5 | BUILT |
| S-0280 | Stripe Connect "Pay Now" | Hosted `/pay/[token]`; Express connected accounts; destination charges; public intent route | [H] D40 Part VII 12.1; S38 | GATE 12.1 DONE & live; Stripe TEST |
| S-0281 | Payment → PAID → GL chain | Balanced AR_COLLECTION; idempotent and safe to resume; never mark PAID if the GL post fails | [H] S38 §1–2; S41 §2 | Proven (card) |
| S-0282 | Verify ACH end to end | processing → succeeded → PAID | [H] S38 §4 #2 | Open |
| S-0283 | Issuer sees ACH processing | Payer timing labels: "Confirms instantly" / "Clears in 1–2 business days" | [H] S38 §1, §5 | Built |
| S-0284 | Per-merchant processing-fee schedules | Versioned per merchant, set by the platform admin. Default ACH 1% capped at $10; card 3% uncapped. Fee is rounded and clamped | [H] S38 §3 (mig 057) | Built |
| S-0285 | Surcharge cascade | Pass or absorb, decided entity → customer → job → invoice (tri-state); ACH absorbed by default, card passed through | [H] S38 §3 (mig 050 / 058) | Built |
| S-0286 | Fee transparency | What the customer sees, what is charged and what posts to GL must all match | [H] S38 §5 | Requirement |
| S-0287 | Merchant fee schedule admin UI | No UI yet; SQL only | [H] S38 §4 #5 | Backlog |
| S-0288 | White-label Stripe onboarding | Embedded components instead of Stripe-hosted Express; switch to interchange-plus only at ~$10M+/yr | [H] S38 §4 #7 | Backlog |
| S-0289 | Invoice email send | Branded email, PDF attachment, Pay Now button, Send action; tokenized PDF link | [H] S38 §1, §5 | Built (S50: email is not a blocker) |
| S-0290 | Branded invoice PDF | 5 styles | [H] D40 Part IV; S38 | Built |
| S-0291 | Credit memos | Create / post / apply / void; posting credits deferred revenue (2410) when linked to a rev-rec job | [H] S42 §2 (mig 071) | Built |
| S-0292 | Void and write-off | Void reverses the AR posting (paid invoices need a credit memo); write-off is DR Bad Debt Expense (by role) / CR AR; AR aging excludes WRITTEN_OFF | [H] S42 §2; S46 §2 (mig 098) | Built |
| S-0293 | Recurring invoices | Templates, cadence math, generate when due, optional auto-send | [H] S42 §2 (mig 073) | Built |
| S-0294 | Dunning and late fees | Listed in Invoice FPB scope; collections workflow + dunning cadence built; escalating dunning + pay-date prediction in flight | [H] D40 Part V.0; S44; S46 §5 | Dunning built; late fees not confirmed |
| S-0295 | Shareable link + view tracking | Invoice FPB scope | [H] D40 Part V.0 | Link built; view tracking not confirmed |
| S-0296 | AR collections / DSO dashboard | Aging buckets, DSO, average days to pay, ranked worklist with one-click reminder, per-customer rollup | [H] S41 §2; S42 | Built (`/collections`; legacy `/invoices/collections` to remove) |
| S-0297 | Customer statements | Branded PDF (aging + open items) + email; AR activity ledger | [H] S42 §2; S49 §2; [D2] AR Group F; [D1] CATv2 AR-C31 | Built; BUILT; Med 3.15; built |
| S-0298 | Customer deposits / retainers | Take: DR Cash / CR 2420. Apply to an invoice (over-application impossible). Refund remainder. Ties out to GL 2420 | [H] S50 §2 (mig 140) | Built |
| S-0299 | AI cash application | Matches unapplied deposits to open invoices (single or sum-to-total); human-approved apply; AR subledger ↔ GL tie-out | [H] S42 §2; S44 §2; [D1] CATv2 AR-C22; CATv1 C1; BKP CORE-11; CFO #7 | Built; Crit 3.90; built propose-only; Top30 #8 |
| S-0300 | Unified collapsible AR aging | Billed + unbilled (1180) combined per customer; expand to child rows and invoice/job lines; same model in exports | [H] S50 §2 | Built |
| S-0301 | AR posts to AR control (1100) by role | Fixed misposting to 12xx; `v_ar_aging` ties to GL 1100 | [H] S50 §2 (mig 149) | Fixed |
| S-0302 | Edit with override | Drafts edit freely; posted invoice/JE needs a typed reason → audit log; a financial change reverses and reposts | [H] D40 Part XI | Built |
| S-0303 | Billing request vs issued invoice | Projects owns the draft draw (no GL); Books issues the invoice and mints its number; corrections only by credit memo or void-and-reissue | [H] D10 Matrix "Invoices" | Canon |
| S-0304 | Progress billing + retainage | DR AR / CR Revenue (or billings in excess); retainage receivable; retainage account 2010 | [H] D20; D40 Part III (mig 036) | Canon / built |
| S-0305 | Bad-debt allowance method | Allowance; write-off against allowance; per-tenant policy choice | [H] D20 | Canon |
| S-0306 | Cash sale / undeposited funds | DR Cash or Undeposited / CR Revenue | [H] D20 | Canon |
| S-0307 | NL draft-invoice lane (P4) | Propose → approve | [H] S43 | Built; AI down |
| S-0308 | Customer management | Duplicate detection + merge (jobs repoint to the survivor); credit/risk dossier | [H] S43 §2; S44 | Built |
| S-0309 | Books-owned customer fields | Payment terms, credit limit, AR standing, opening AR | [H] D10 core.customers | Canon |
| S-0310 | Invoices to "Complete" against its product brief | FPB written; final read-through owed | [H] S41; S46 §4 (task #22) | Near-complete |
| S-0311 | Product/service item catalog driving invoice lines | AR-A1 | [D1] CATv2 AR-A1; [D2] AR Group A; P2P S4 M2 | Med 3.05; none; MISSING; AR Tier 4 #8 |
| S-0312 | Rev-rec-aware invoice posting | Managed jobs credit Deferred Revenue 2410, not Revenue. AR-A2. | [D1] CATv2 AR-A2; BKP CORE-11; CPA B6 | High 3.60; partial |
| S-0313 | Recurring invoices that auto-send | Subscriptions and retainers. AR-A4. | [D1] CATv2 AR-A4; [D2] AR Group A; P2P S4 M6 | High 3.40; built; BUILT (mig 073) |
| S-0314 | Revenue-leakage detection (work done, not billed) | Built with Projects. AR-A5. | [D1] CATv2 AR-A5 | High 3.75; partial |
| S-0315 | Attachments and customer-PO capture on invoices | AR-A6 | [D1] CATv2 AR-A6; [D2] AR Group A; P2P S4 M1 | Med 2.95; none; MISSING (column unused); AR Tier 4 #8 |
| S-0316 | Estimate/quote → invoice conversion | AR-A7 | [D1] CATv2 AR-A7; [D2] AR Group A | Low 2.50; none; MISSING; deferred |
| S-0317 | Branded invoice delivery (email + PDF + Pay Now) | Explicit failure codes; never marked SENT on a failed send. AR-B8. | [D1] CATv2 AR-B8; INT §1c, §2.9; [D2] AR Group B; P2P S4 M6 | High 3.50; built; BUILT |
| S-0318 | Delivery / open / bounce tracking | DELIVERED/bounce via Resend webhook; VIEWED via hosted page; bounce warning for collector (AR B9) | [D1] CATv2 AR-B9; [D2] AR Group B; P2P S4 M12 | Med 3.05; partial; PARTIAL (VIEWED only); AR Tier 4 #9 |
| S-0319 | CC / multi-recipient / custom-message send | AR-B10 | [D1] CATv2 AR-B10 | Med 2.80; none |
| S-0320 | Collections / DSO command center and collector worklist | AR-C12 | [D1] CATv2 AR-C12; COV #5; [D2] AR Group C; P2P S5 M11 | High 3.75; built; BUILT |
| S-0321 | Manual one-click reminder | AR-C13 | [D1] CATv2 AR-C13; [D2] AR Group C | Med 3.10; built; BUILT (`/api/invoices/[id]/remind`) |
| S-0322 | Automated tiered dunning ladder | Tone, quiet hours, pausable; auto-send within the dial. AR-C14. | [D1] CATv2 AR-C14; [D2] AR Group C; P2P S5 M6/M9/M10 | Crit 3.60; none; Top30 #11; MISSING; AR Tier 2 #4; "the moat" |
| S-0323 | AI collections outreach drafting | Tone-matched and escalating. AR-C15 / C2. | [D1] CATv2 AR-C15; CATv1 C2; [D2] AR Group C; P2P S5 M6 | High 3.40; none; MISSING; AR Tier 2 #4 |
| S-0324 | Promise-to-pay capture with broken-promise escalation | AR-C16 | [D1] CATv2 AR-C16 | High 3.35; none |
| S-0325 | Pay-date prediction for overdue AR | Part of C2 | [D1] CATv1 C2; COV #5 | gap |
| S-0326 | Payment-plan / installment automation | AR-C17 | [D1] CATv2 AR-C17; [D2] AR Group C | Med 3.05; none; MISSING; AR Tier 4 #11 |
| S-0327 | Credit scoring and credit-limit management | AR-C18 | [D1] CATv2 AR-C18; [D2] AR Group C; P2P S5 M5, S6 M5/M11 | High 3.30; partial; Top30 #20; PARTIAL (columns only); AR Tier 3 #6; bureau deferred |
| S-0328 | Credit-hold automation (order/ship gate) | AR-C19 | [D1] CATv2 AR-C19 | High 3.25; none |
| S-0329 | Auto late fees / finance charges | Opt-in; balanced posting. AR-C20. | [D1] CATv2 AR-C20; [D2] AR Group C | Med 2.95; none; MISSING; AR Tier 2 #5 |
| S-0330 | At-risk / churn signal on the AR book | AR-C21 | [D1] CATv2 AR-C21; [D2] AR Group C; P2P S5 M4/M12 | Med 3.05; none; MISSING; AR Tier 4 #11 |
| S-0331 | Collections agent that sends, handles replies and applies cash | — | [D1] GAP §3B #15 | T2; partial (drafts only) |
| S-0332 | Lockbox / BAI2 file ingestion with auto-apply | AR-C23 | [D1] CATv2 AR-C23; INT §2.1 | Med 3.00; none |
| S-0333 | Partial / short-pay handling opens a deduction | AR-C24 | [D1] CATv2 AR-C24 | High 3.30; none |
| S-0334 | Unapplied-cash / on-account and customer-deposit ledger | AR-C25 | [D1] CATv2 AR-C25; [D2] AR Group D | High 3.25; none; Top30 #8; MISSING; AR Tier 1 #2 |
| S-0335 | Dispute / deduction detection and resolution workflow | AR-C26 | [D1] CATv2 AR-C26; [D2] AR Group D; P2P S5 M2 | High 3.30; none; MISSING; AR Tier 1 #3 (Disputes FPB) |
| S-0336 | Credit memos (issue / apply / refund bridge) | AR-C27 | [D1] CATv2 AR-C27; [D2] AR Group E | High 3.35; built (refund bridge none); BUILT (mig 071); refund bridge MISSING (Tier 4 #10) |
| S-0337 | Void and reissue | Keeps the number; watermark. AR-C28. | [D1] CATv2 AR-C28; [D2] AR Group E | Med 3.10; built; BUILT (watermark/clone linkage to verify) |
| S-0338 | Bad-debt write-off and allowance for doubtful accounts | Reserve proposal with rationale; SoD approval. AR-C29 = GL-D4. | [D1] CATv2 AR-C29, GL-D4; CFO #7; [D2] AR Group E; GLC Group D; P2P S5 M5 | High 3.40; partial; PARTIAL (write-off posting built); AR Tier 3 #7 |
| S-0339 | Refunds (overpayment / credit → money out) | AR-C30 | [D1] CATv2 AR-C30 | Med 3.00; none |
| S-0340 | Online Pay Now (ACH + card) via Stripe Connect | Hosted page; Express onboarding. Webhooks `payment_intent.succeeded/processing` → PAID + balanced GL. Resume-safe idempotency; migration 064 UNIQUE indexes. AR-C32. | [D1] CATv2 AR-C32; INT §2.2 | High 3.55; built & live (Gate 12.1) |
| S-0341 | Two-layer merchant-fee model | Charge vs pass-through/absorb. AR-C33. | [D1] CATv2 AR-C33 | Med 3.10; built |
| S-0342 | AR subledger ↔ GL control-account tie-out with unapplied-cash close gate | AR-C35 | [D1] CATv2 AR-C35 | Crit 3.70; none; Top30 #8 |
| S-0343 | Pre-send billing-error detection | Wrong price/qty/tax that would cause a silent dispute. NEW-AR1. | [D1] CATv2 §6.2; [D2] P2P S4 M4 | none; NONE ⭐NEW; AR top-3 (a) |
| S-0344 | Email/PDF remittance-advice parsing for cash application | Payer + invoice list from email/PDF (distinct from bank file) | [D1] CATv2 §6.2; [D2] P2P S5 M1 | none; NONE ⭐NEW; "highest-value miss" |
| S-0345 | Invoice send-time / channel optimization | NEW-AR3 | [D1] CATv2 §6.2; [D2] P2P S4 M11 | none; NONE ⭐NEW |
| S-0346 | Early-pay-discount offer optimization | NEW-AR4 | [D1] CATv2 §6.2; [D2] P2P S5 M11 | none; NONE ⭐NEW |
| S-0347 | Collections-interaction history retrieval | "What was already tried" | [D1] MATRIX §2 (M13), §4 #11; [D2] P2P S5 M13 | none; NONE ⭐NEW |
| S-0348 | Customer onboarding document extraction | Credit application, resale certificate. NEW-CU1. | [D1] CATv2 §6.2; [D2] P2P S6 M1 | none; Top30 #20; NONE ⭐NEW |
| S-0349 | Customer classification / segmentation | NEW-CU2 | [D1] CATv2 §6.2; [D2] P2P S6 M2 | none; NONE ⭐NEW |
| S-0350 | Duplicate-customer detection and merge | Mirror of the vendor dedupe. NEW-CU3. | [D1] CATv2 §6.2; [D2] P2P S6 M3 | none; Top30 #20; NONE ⭐NEW; "highest-value miss"; Seg 6 top-3 (a) |
| S-0351 | Customer credit-abuse / fraud detection | NEW-CU4 | [D1] CATv2 §6.2; [D2] P2P S6 M4 | none; NONE ⭐NEW |
| S-0352 | Customer-facing communications drafting | NEW-CU5 | [D1] CATv2 §6.2; [D2] P2P S6 M6 | none; NONE ⭐NEW |
| S-0353 | Customer credit re-review and master-staleness monitor | Stale credit treated as a leak | [D1] CATv2 §6.2; [D2] P2P S6 M12 | none; NONE ⭐NEW |
| S-0354 | Customer-360 profile | Payment behavior, credit, risk. The customer master is currently a thin CRUD screen. | [D1] COV #20; MATRIX §4 #20 | under-discovered (Low) |
| S-0355 | CC / multiple recipients / send-me-a-copy / custom message | Multiple AP contacts; editable cover message (AR B10) | [D2] AR Group B | MISSING; AR Tier 4 #9 |
| S-0356 | Promise-to-pay capture & tracking | PTP object; suppresses dunning until the date; broken promise → auto-escalate; feeds worklist and cash forecast (AR C16) | [D2] AR Group C; P2P S5 M12 | MISSING; AR Tier 2 #4 |
| S-0357 | Credit-hold automation | Over limit or seriously past due → hold new invoices/orders; logged supervisor override (AR C19) | [D2] AR Group C; P2P S6 M11 | MISSING; AR Tier 3 #6 |
| S-0358 | AI cash application (deposit → open AR) | Single-invoice exact/near; lump remittance via subset-sum across a resolved payer's invoices; payer resolution from description; PROPOSED `ai_decisions` → `/exceptions`; dedup `cashapp:<bank_txn_id>` (mig 070); approve → DR Cash / CR AR + apply (AR C22, BC B8) | [D2] AR Group D; BC Group B; GLC D3; R2R S3 M3; P2P S5 M3 | BUILT (propose-only); approve→post wire = AR Tier 1 #2 |
| S-0359 | Lockbox / BAI2 / remittance file ingestion | Check images, remittance detail; bulk auto-apply; handles no-remittance and split remittances (AR C23) | [D2] AR Group D | MISSING; AR Tier 4 #11 |
| S-0360 | Partial-payment & short-pay handling | Customer pays part online; short-pay opens a deduction rather than silent write-off (AR C24) | [D2] AR Group D | MISSING; AR Tier 1 #3 |
| S-0361 | Refunds | Stripe refund with balanced reversal + REFUNDED event; money-out SoD (AR C30) | [D2] AR Group E | MISSING; AR Tier 4 #10 |
| S-0362 | Invoice / AR treatment narrative | e.g. "Credits Deferred 2410 because job X is %-complete rev-rec" | [D2] P2P S4 M7 | NONE ⭐NEW |
| S-0363 | NL invoice create/query | "Bill Acme for March retainer; show unpaid >$10k" | [D2] P2P S4 M8 | NONE ⭐NEW |
| S-0364 | Invoice/customer history retrieval | Every invoice + status + note for an account | [D2] P2P S4 M13 | NONE ⭐NEW |
| S-0365 | Per-customer invoice memory | Preferred format, PO requirement, AP contact | [D2] P2P S4 M14 | NONE ⭐NEW |
| S-0366 | Collections account-summary narrative | e.g. "Promised Fri, broke 2x, 68 DTP vs 41 avg, $12k" | [D2] P2P S5 M7 | NONE ⭐NEW |
| S-0367 | NL collections query | "Who to call today, biggest × oldest, exclude disputed" | [D2] P2P S5 M8 | partial ⭐NEW |
| S-0368 | Per-customer payment-behavior learning | Days-to-pay, promise reliability, dispute rate | [D2] P2P S5 M14 | partial |
| S-0369 | Customer master setup | Terms (`payment_terms_days`, default 30), `credit_limit_cents`, tax status, remit/bill-to, contacts, credit review with trade references | [D2] AR Part 1 §1 | columns exist |
| S-0370 | Customer-360 narrative | YTD $, DTP, open disputes, limit used, trend | [D2] P2P S6 M7 | NONE ⭐NEW |
| S-0371 | NL customer query | "Top 10 by overdue; who is over limit" | [D2] P2P S6 M8 | NONE ⭐NEW |
| S-0372 | Customer knowledge retrieval | Contacts, PO rules, prior disputes, comms history | [D2] P2P S6 M13 | NONE ⭐NEW |
| S-0373 | Per-customer preference / behavior memory | Billing format, AP portal, remittance quirks | [D2] P2P S6 M14 | NONE ⭐NEW |
| S-0374 | Multi-currency AR / batch invoicing | Seam only | [D2] AR Part 3 deferred | Deferred (GATE 11) |

## Revenue recognition & WIP (incl. unbilled 1180, deferred 2410, over/under billings)

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 186 | Revenue Recognition — 4 methods (% costs, % complete, completed contract, POS) | Spec: 4 methods; engine now 9 (adds milestone, as-billed, ratably, subscription, cash). MD9 note: logic in VIII.1; no page | Audit #186 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 187 | Revenue Recognition — Monthly automation (1st at 2:00 AM) | 1st of month 2:00 AM: % complete → JEs → post → snapshot. MD9 note: logic in VIII.1; no page | Audit #187 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 188 | Revenue Recognition — Two COGS routing trees | Tree 1 job-cost categories → WIP/COGS clearing; Tree 2 AI prepaid/deposit/capitalize. MD9 note: logic in VIII.1; no page | Audit #188 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 189 | Revenue Recognition — Monthly snapshots | MD9 note: logic in VIII.1; no page | Audit #189 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 190 | Revenue Recognition — Correction approach (true-up forward / retroactive) per company | True-up forward or retroactive restatement, per company. MD9 note: logic in VIII.1; no page | Audit #190 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 191 | WIP Reports — Job-level WIP schedule (contract, costs, % complete, over/under) | Contract, costs to date, % complete, est. cost to complete, over/under billed. MD9 note: v_job_profitability | Audit #191 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 256 | WIP schedule (contract, costs to date, % complete, over/under billed) | MD9 note: v_job_profitability | Audit #256 (Cat 12); BuildSpec v4.3 §04, §22; MD9 Part V; BuildSpec v4.3 §10 | Apr-26 audit: SCHEMA; MD9: ⬜; seq P1-HIGH |
| 261 | Revenue recognition integration (4 methods feed from job data) | MD9 note: recognition engine built + posts (Part XI); job-costing UI wiring pending | Audit #261 (Cat 12); BuildSpec v4.3 §04, §22; MD9 Part V | Apr-26 audit: MISSING; MD9: 🔶; seq P1-HIGH |
| S-0375 | Two COGS routing trees: Tree 1 rev-rec-driven routes job_cost_categories to WIP or COGS Clearing; Tree 2 AI exceptions evaluates non-COGS expenses for prepaid, deposit or capitalization |  | BuildSpec v4.3 §10 |  |
| S-0376 | Monthly rev-rec automation (1st, 2:00 AM): completion % per job → JEs → post → monthly snapshot; correction approach true-up forward or retroactive restatement per company |  | BuildSpec v4.3 §10, §19 |  |
| S-0377 | AR→rev rec integration: invoice posting triggers % complete updates |  | BuildSpec v4.3 §21 |  |
| S-0378 | WIP schedule incl. estimated cost to complete and WIP asset/liability (over/under billings) |  | BuildSpec v4.3 §22 | BLOCKER |
| S-0379 | Rev-rec method chosen per revenue type (revenue account) per company with per-job override; resolution override → revenue type → job type map → company default | One company can run several methods | MD9 XI.2, X.1 | BUILT |
| S-0380 | Rev-rec earned-to-date by method: cost-to-cost, physical %, completed contract, milestone, point of sale, as-billed, ratable/subscription, cash | 9 methods in engine | MD9 XI.2 | BUILT |
| S-0381 | Billing decoupled from recognition: invoices credit Revenue only for POS/as-billed; otherwise Deferred 2410, earned out by engine; posting DR Deferred 2410 (billings in excess) + DR Unbilled 1180 / CR Revenue; reversal if negative delta |  | MD9 XI.2 | BUILT |
| S-0382 | Standalone path: accounting keys recognition inputs (contract, estimate, % complete) on Jobs → Recognition Inputs |  | MD9 XI.2 | BUILT |
| S-0383 | Job Review Queue for job-cost-category spend with no job (routes to COGS Clearing) |  | MD9 VIII.1 |  |
| S-0384 | Retainage receivable as a separate receivable until released; progress billing to Billings in Excess when billed ahead of earned |  | Posting Engine Spec B2 |  |
| S-0385 | JOB_PROGRESS snapshots (contract value incl. approved change orders, cost estimate at completion, physical % complete) pinned and recognized per resolved method; self-heals on next snapshot |  | Event Contract §5 | BUILT |
| S-0386 | Service rev-rec methods RATABLY, AS_BILLED, MILESTONE, SUBSCRIPTION with smart defaults from pricing model (Retainer→Ratably, Subscription→Subscription, Hourly/T&M→As Billed, fixed/cost-plus/unit inherit company method) |  | Handoff S8 §2 | BUILT |
| S-0387 | WIP classification ON_TRACK (/variance/<$10) / OVERBILLED (amber) / UNDERBILLED (blue) |  | Handoff S8 §3 | BUILT |
| S-0388 | Nine rev-rec methods | % of costs incurred, % complete, completed contract, point of sale, milestone, as billed, ratably, subscription, cash | [H] ANCHOR §3; D20; [D1] COV #18; MGR C; CFO #8 | Built; built |
| S-0389 | Method resolution order | Per-job override → per revenue type → company default → legacy job-type map | [H] ANCHOR §3; D10 | Canon |
| S-0390 | Defer vs recognize at billing | Rev-rec jobs credit Deferred Revenue 2410 (except point of sale / as billed); manual and event-driven billing aligned | [H] D10; S41 §2 | Built |
| S-0391 | Post the earned delta | Earned minus already recognized: DR 2410 + DR 1180 remainder / CR Revenue; reverses if negative; runs monthly on the 1st at 2 AM; COGS routing trees | [H] D40 Part VIII, Part XI | Built |
| S-0392 | Onboarding offers all 9 methods | Plain-language industry guidance | [H] S41 §2 | Built |
| S-0393 | EC-6 revenue-not-recognized detector | Flags schedules due to release, stalled, or inconsistent with billing | [H] S42; [D1] CFO #8; COV #18 | Built; built (control) |
| S-0394 | Rev-rec reporting | Deferred-revenue rollforward, per-contract waterfall, method summary | [H] S49 §2 | Built |
| S-0395 | Unbilled-revenue accrual (owner ask) | DR 1180 / CR Revenue for under-billed jobs; adjusts to target; self-reverses; idempotent; view-only preview for CFO | [H] S50 §2 | Built |
| S-0396 | Rev-rec accounts resolved by role + idempotent | 2410 / 1180 / revenue by role; one run per job per month | [H] S50 §2 | Fixed |
| S-0397 | Job costing: EAC + WIP over/under billing | Estimate at completion; WIP schedule; `/jobs/wip` nav | [H] S43; S44 | Built |
| S-0398 | Job POC P&L + deeper WIP schedule | — | [H] S49 §2 | Built |
| S-0399 | GATE 6 job-costing depth | Phases / cost codes, WIP schedule, change orders | [H] D40 Part VII | OPEN (partly built) |
| S-0400 | Projects ↔ Books events | JOB_COST (Books → Projects, PENDING → CLEARED); JOB_PROGRESS and JOB_BILLING (Projects → Books); frozen v3 contract | [H] D10 FILE 3 | Canon; verified |
| S-0401 | Books works without Projects | Rev-rec inputs keyed directly into `core.jobs` | [H] D10 | Canon |
| S-0402 | Deferred-revenue release (rev-rec driven) | `rev-rec.ts` (9 methods, method-per-job); release on schedule/POC; AI never invents % complete (GLC B3) | [D1] CATv2 GL-B3; CFO wk1; [D2] GLC Group B | High 3.50; built; LIVE (contract/subscription/project tenants) |
| S-0403 | Revenue and expense cutoff enforcement | Near close, compare invoice/bill date to delivery/performance evidence. F4 / TX-F2. | [D1] CATv1 F4; CATv2 TX-F2; CPA B6 | High 3.05; built (detect) |
| S-0404 | ASC 606 contract document extraction → performance obligations / price / SSP | NEW-RR1 | [D1] CATv2 §6.1; MATRIX §3b | Crit (theme); none; Top30 #19 |
| S-0405 | AI allocation of price to performance obligations | NEW-RR2 | [D1] CATv2 §6.1 | none |
| S-0406 | Billed ↔ recognized ↔ deferred waterfall tie-out | NEW-RR3 | [D1] CATv2 §6.1; [D2] R2R S5 M3 | none; spec ⭐NEW; R2R S5 #2 |
| S-0407 | Deferred-revenue roll-off forecast | NEW-RR4 | [D1] CATv2 §6.1; [D2] R2R S5 M5 | none; spec ⭐NEW |
| S-0408 | ASC 606 / SSP memo drafting | Draft memos | [D1] CATv2 §6.1; [D2] R2R S5 M6 | none; spec ⭐NEW |
| S-0409 | Best-fit rev-rec method recommendation | NEW-RR6 | [D1] CATv2 §6.1; [D2] R2R S5 M11 | none; spec ⭐NEW |
| S-0410 | Milestone-due monitor | NEW-RR7 | [D1] CATv2 §6.1; [D2] R2R S5 M12 | none; partial (milestone monitor ⭐NEW) |
| S-0411 | Rev-rec rationale shown on the invoice | M7 narrative | [D1] MATRIX §2 | none |
| S-0412 | Cost-to-complete / EAC forecast with %-complete true-up | Percent-complete revenue true-up; margin-at-completion; job cash flow; over/under-billing projection | [D1] CATv2 §6.3; GAP #23; [D2] FTP §6 M5 | High; partial (EAC narrative); Top30 #25; NONE ⭐NEW; Job-cost top-3 (a); GATE 6 |
| S-0413 | WIP over/under-billing schedule and true-up | NEW-JC2 | [D1] CATv2 §6.3; COV #16; [D2] FTP §6 M3/M6 | none; partial ⭐NEW; top-3 (b) |
| S-0414 | Margin-fade / cost-overrun detection | Detection | [D1] CATv2 §6.3; [D2] FTP §6 M4 | none; NONE ⭐NEW; top-3 (c) |
| S-0415 | Change-order-leakage detection | NEW-JC4 | [D1] CATv2 §6.3; [D2] FTP §6 M4 | none; NONE ⭐NEW |
| S-0416 | Job-cost monitoring alerts | Budget crossing, margin fade, unbilled-cost aging, retainage overdue, over-billing > cost | [D1] CATv2 §6.3; [D2] FTP §6 M12 | none; NONE ⭐NEW |
| S-0417 | Estimate/contract value → job budget baseline | Imported from ERPs; drives cost-to-complete / WIP | [D1] ERP §1, §3.2 | spec |
| S-0418 | Construction contract overlays | Percentage-of-completion vs completed-contract, §460 look-back, retainage, job-cost cutoff | [D1] CPA Part C | segment |
| S-0419 | JOB_PROGRESS events drive rev-rec timing | Projects → Books | [D1] INT §2.8 | built |
| S-0420 | Rev-rec-aware invoice posting | Managed-job invoice credits Deferred Revenue 2410 (+1180 unbilled remainder), not revenue; method cascade per-job → per-revenue-type → company default; UI shows resolved treatment before posting (AR A2) | [D2] AR Group A; P2P S4 M2 | PARTIAL (verify manual-create UI) |
| S-0421 | Revenue-not-recognized / stalled / ahead-of-delivery detector | Deferral due but not released, or revenue before delivery | [D2] R2R S5 M4; GLC 1.5 #8 | BUILT (`revenue-not-recognized.ts`) |
| S-0422 | ASC 606 contract IDP | Parses contract/SOW for performance obligations (POBs), transaction price, milestones, SSP (standalone selling price) → proposes rev-rec facts | [D2] R2R S5 M1 | spec ⭐NEW; "major miss"; R2R S5 #1 |
| S-0423 | Revenue-stream → method classification + AI POB price allocation | Allocates price across POBs | [D2] R2R S5 M2 | partial ⭐NEW |
| S-0424 | Deferred-rev rollforward narrative | Additions, releases, modifications | [D2] R2R S5 M7 | spec ⭐NEW |
| S-0425 | NL rev-rec | "Show deferred-rev waterfall / recognize milestone 2" | [D2] R2R S5 M8 | spec ⭐NEW |
| S-0426 | End-to-end rev-rec run | Schedule and propose all period releases across jobs (`rev-rec-run.tsx`) | [D2] R2R S5 M9 | partial |
| S-0427 | Auto-release deferral dial | Auto-post scheduled releases within the dial | [D2] R2R S5 M10 | partial |
| S-0428 | Contract-terms retrieval + ASC 606 Q&A | e.g. "Which contracts have termination for convenience" | [D2] R2R S5 M13 | spec ⭐NEW |
| S-0429 | Method-per-revenue-type + SSP library memory | Learned defaults | [D2] R2R S5 M14 | spec ⭐NEW |
| S-0430 | Revenue-leakage / unbilled-WIP detection | JOB_COST vs JOB_BILLING/JOB_PROGRESS; earned > billed; expired-unbilled T&M; un-passed-through costs; unbilled COs; 1180 roll-forward; coordinate with Projects Billing Auditor (AR A5) | [D2] AR Group A; P2P S4 M3/M12; FTP §6 M3 | PARTIAL (joint with Projects) |
| S-0431 | Job-cost doc extraction | Subcontractor invoices, lien waivers, AIA G702/G703 pay apps | [D2] FTP §6 M1 | partial ⭐NEW |
| S-0432 | Change-order draft | Draft | [D2] FTP §6 M6 | partial ⭐NEW |
| S-0433 | Job-cost variance narrative | Why margin faded; which cost code overran; CO impact; WIP movement | [D2] FTP §6 M7 | NONE ⭐NEW |
| S-0434 | NL job queries (cross-domain) | "Jobs over budget AND behind billing AND dragging DSCR" | [D2] FTP §6 M8 | → nl-copilot (A7 moat) |
| S-0435 | Progress-billing cycle orchestration | Pull JOB_PROGRESS → % complete → true-up deferred → draft pay app → post on approval | [D2] FTP §6 M9 | partial ⭐NEW |
| S-0436 | Job governance rule | AI proposes % complete / EAC, never invents it; human owns the true-up | [D2] FTP §6 M10 | partial |
| S-0437 | Bid/estimate accuracy, job-mix/margin optimization, retainage-release timing, sub vs self-perform signal | Recommendations | [D2] FTP §6 M11 | NONE ⭐NEW |
| S-0438 | Job history / prior similar job + contract/CO retrieval | Retrieval | [D2] FTP §6 M13 | NONE ⭐NEW |

## Job costing & project accounting

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 56 | Progress invoicing / AIA billing (G702/G703) | Progress invoicing from estimate; AIA G702/G703. MD9 note: fields only | Audit #56 (Cat 3); BuildSpec v4.3 §04 AR, §21; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶; seq P1-HIGH |
| 252 | Job/project setup (number, name, customer, contract, estimated cost) | Job #, name, customer, contract, estimated cost, phases/cost codes. MD9 note: list+create wired; ADD department_id | Audit #252 (Cat 12); BuildSpec v4.3 §04, §22; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶; seq P1-HIGH |
| 253 | Phase/cost code structure within jobs | MD9 note: job_phases/job_cost_codes | Audit #253 (Cat 12); BuildSpec v4.3 §04, §22; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ⬜; seq P1-HIGH |
| 254 | Budget at phase level with cost code breakdown |  | Audit #254 (Cat 12); BuildSpec v4.3 §04, §22; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH |
| 255 | Cost tracking by category (labor, materials, subcontractor) | MD9 note: job_cost_entries | Audit #255 (Cat 12); BuildSpec v4.3 §04, §22; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ⬜; seq P1-HIGH |
| 257 | Job profitability analysis (margin %, trend, estimated vs actual) | MD9 note: renderer | Audit #257 (Cat 12); BuildSpec v4.3 §04, §22; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶; seq P1-HIGH |
| 258 | Progress billing / AIA billing (G702/G703) | Draws by % complete or milestone; AIA G702/G703. Spec: Schedule of values (SOV), G702/G703, `is_progress_bill`, `application_number`, retainage cascade (job→customer); issuer sets % complete; AI drafts pay app (AR A3) | Audit #258 (Cat 12); BuildSpec v4.3 §04, §22; MD9 Part V; [D2] AR Group A; FTP §6 M6 | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH; PARTIAL (SOV entry UI thin) |
| 259 | Change order management (scope, cost, revenue impact, approval) | Scope/cost/revenue impact, approval, adjusts budget & contract. MD9 note: change_orders | Audit #259 (Cat 12); BuildSpec v4.3 §04, §22; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ⬜; seq P1-HIGH |
| 260 | Retainage tracking (withhold %, receivable, payable, release) | Withhold %, receivable & payable, release workflow | Audit #260 (Cat 12); BuildSpec v4.3 §04, §22; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH |
| 262 | Subcontractor management (agreements, insurance, lien waivers) | Sub agreements, insurance, lien waivers, pay applications | Audit #262 (Cat 12); BuildSpec v4.3 §04, §22; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH |
| 263 | Resource management and utilization reporting |  | Audit #263 (Cat 12); BuildSpec v4.3 §04, §22; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH |
| 264 | Project time and expense capture (mobile + receipts) | MD9 note: receipt capture in scope; time out | Audit #264 (Cat 12); BuildSpec v4.3 §04, §22; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH |
| 265 | Estimated vs actual tracking at phase/cost code level |  | Audit #265 (Cat 12); BuildSpec v4.3 §04, §22; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH |
| S-0439 | Job setup with phases/cost codes and budget at phase level |  | BuildSpec v4.3 §22 | BLOCKER |
| S-0440 | Job cost tracking per job/phase: labor from time entries, materials from receipts/bills, subcontractor costs |  | BuildSpec v4.3 §22 | BLOCKER |
| S-0441 | Job profitability: margin %, trend, estimated vs actual, flag jobs exceeding budget |  | BuildSpec v4.3 §22 | BLOCKER |
| S-0442 | Progress/AIA billing: draw requests by % complete or milestone, AIA G702/G703 |  | BuildSpec v4.3 §22 | BLOCKER |
| S-0443 | Change orders: scope, cost and revenue impact, approval, adjust job budget and contract amount |  | BuildSpec v4.3 §22 |  |
| S-0444 | Estimated vs actual by phase/cost code with variance and forecast remaining cost |  | BuildSpec v4.3 §22 |  |
| S-0445 | Retainage: configurable % withheld, retainage receivable and payable, release workflow |  | BuildSpec v4.3 §22 |  |
| S-0446 | Subcontractor management: agreements, insurance tracking, lien waiver collection, pay application processing |  | BuildSpec v4.3 §22 |  |
| S-0447 | Books↔Projects seams via core.events: JOB_COST (Books→Projects), JOB_PROGRESS, JOB_BILLING, DEPT_INVOICE_ISSUE (Projects→Books); idempotent; reject on hard-closed period | Two-number model (pending vs cleared cost) | MD9 IV.8, XI.3 | BUILT |
| S-0448 | Subcontractor retainage payable withheld at bill approval (2010) + release register; /retainage page |  | MD9 XI.9 (mig 036) | BUILT |
| S-0449 | GATE 6 job costing depth: cost-code management UI, phase budgets, cost by cost code, WIP ties to GL, change-order contract roll-forward, est vs actual |  | MD9 GATE 6 | OPEN |
| S-0450 | Job cost lifecycle events PENDING (bill awaiting approval) / CLEARED (approved or bank-feed categorized to job / timesheet-payroll approved) / VOIDED; GL lines stamped with job_id |  | Event Contract §3, §6–7 | BUILT |
| S-0451 | Jobs serve both construction projects and service engagements; pricing models FIXED_PRICE, COST_PLUS, UNIT_PRICE, TIME_AND_MATERIALS, HOURLY, RETAINER, SUBSCRIPTION | Service fields: monthly retainer, hourly rate, budget/actual hours, milestones, service dates, billing frequency | Handoff S8 §2 | BUILT (schema/API) |
| S-0452 | Job fields: markup %, estimated revenue, retainage %, job site address, superintendent, project manager, taxable/tax fields, original vs current contract, approved change orders, notes |  | Handoff S8 (mig 011) | BUILT |
| S-0453 | Estimated revenue by pricing model (fixed=contract; cost-plus=cost×(1+markup); T&M=hours×rate×(1+markup); retainer=monthly×months) | Job creation validation per method (e.g. POC needs estimated cost; ratably needs retainer; milestone needs count) | Handoff S8 §3 | BUILT |
| S-0454 | % complete auto-computed per method (cost ratio, milestone ratio, elapsed time, hours ratio) |  | Handoff S8 §2 | BUILT |
| S-0455 | Job creation form with conditional fields per pricing model (project vs service) |  | Handoff S8 §4 | P1 (S8) |
| S-0456 | Progress / AIA billing in Books | Schedule of values, G702/G703, retainage. AR-A3 / NEW-JC5. Today it lives only in Projects. | [D1] CATv2 AR-A3; GAP #21 | High 3.30; partial |
| S-0457 | Per-cost-code estimate-vs-actual learning; per-customer billing behavior | Learning | [D2] FTP §6 M14 | NONE ⭐NEW |

## Payroll

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 180 | Payroll Journal Entries — ADP import per company per period | Payroll provider import (ADP originally) per company per period. MD9 note: no page | Audit #180 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 181 | Payroll JEs — Gross Wages/FICA/FUTA/SUTA/Health/401k breakdown | Gross wages, FICA, FUTA/SUTA, health, 401k; liabilities + net pay. MD9 note: no page | Audit #181 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 182 | Payroll JEs — Edit Allocations + Approve & Post | MD9 note: no page | Audit #182 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| S-0458 | Payroll JE layout: DR Gross Wages, Employer FICA, FUTA/SUTA, Health Insurance, 401(k) match; CR Payroll Liabilities and Checking (net pay); per company per period; Edit Allocations; Approve & Post |  | BuildSpec v4.3 §10 |  |
| S-0459 | Payroll visibility two-tier: individual pay vs department totals |  | MD9 IV.3 |  |
| S-0460 | Payroll provider integration (Check or Gusto Embedded): run posted from provider receipt — gross by department, withholdings incl. garnishments, employer taxes, employer benefits (health 6020, 401k 6030, WC 6040), net pay to in-transit; provider auto-remits child-support garnishments; files new-hire reports | Payroll PII stays with provider/Core; full HR detail reserved for MeritHR | MD9 GATE 12.3 | GL layer BUILT; adapter not |
| S-0461 | Payroll run GL template | DR wages / employer tax / benefits; CR cash (net), tax, benefit and withholding payables; remittance clears payables | [H] D20 | Canon |
| S-0462 | GATE 12.3 Phase A | Provider-agnostic engine (mock + Check adapter); DRAFT → PREVIEWED → APPROVED → RELEASED → PAID; release is the only money step; balanced PAYROLL_RUN entry | [H] S42 §2 (mig 069) | Built |
| S-0463 | Phase B | Releaser ≠ preparer, double-post guard, live Check | [H] S42 §4 (task #34) | Blocked on provider pick (Check vs Gusto; leaning Check) |
| S-0464 | No payroll PII in app tables | SSN, bank and withholding stay with the provider / Vault | [H] D10; S42 | Canon |
| S-0465 | Payroll register importer (no AI) | CSV/XLSX → mapped columns → balanced JE; mappings saved; the honest primary payroll path | [H] S49 §2 (mig 136) | Built |
| S-0466 | Mock run labeled an estimate | "No money moves, not a tax calculation" | [H] S48 §2 | Built |
| S-0467 | Payroll remittance route | `/remit` clears tax/benefit payables; idempotent | [H] S50 §2 | Built |
| S-0468 | Releaser ≠ approver | — | [H] S50 §2 | Built |
| S-0469 | Garnishments payable + employer benefit roles | Account 2270 | [H] D40 Part III (mig 044 / 045) | Built |
| S-0470 | Payroll in cash forecast | Forecast doesn't yet model payroll, taxes or recurring transfers | [H] S40 §4 | Open |
| S-0471 | Payroll journal automation | Balanced JE (gross / employer taxes / withholdings / net) with department/job splits; `entry_type=PAYROLL_RUN`; human confirms. B4 / CORE-10. | [D1] CATv1 B4; BKP CORE-10 | 3.30; partial (Gate 12.3 Phase A) |
| S-0472 | Provider-agnostic payroll engine | Check / Gusto / ADP. Books holds handles and amounts only. Mock adapter live; Check adapter scaffolded. Fails gracefully with `PayrollProviderNotConfiguredError`. | [D1] INT §2.3; COV #15 | partial; provider not chosen |
| S-0473 | Payroll Phase B | Releaser ≠ preparer; double-post guard; live sandbox | [D1] INT §2.3, §4 #2 | gated on provider pick |
| S-0474 | Embedded run → post → remit → file | — | [D1] COV #15 | spec only |
| S-0475 | Payroll-run anomaly review | N× paycheck, terminated employee still paid, missing hours. NEW-PR1. | [D1] CATv2 §6.3; [D2] FTP §4 M4 | High; none; Top30 #22; spec ⭐NEW; top-3 (a) "highest-value payroll AI" |
| S-0476 | Labor → job/department/class attribution at the pay line | NEW-PR2 | [D1] CATv2 §6.3 | none; Top30 #22 |
| S-0477 | Auto-reconcile the provider's bank debit to the posted run | Against posted run + payable clearings; payroll-liability → GL tie-out | [D1] CATv2 §6.3; [D2] FTP §4 M3 | none; Top30 #22; spec ⭐NEW; top-3 (c) |
| S-0478 | Employer-tax and PTO-liability run-rate forecast | Feeds 13-week forecast and FP&A comp plan | [D1] CATv2 §6.3; [D2] FTP §4 M5 | none; partial ⭐NEW |
| S-0479 | Pay register / branded pay-stub drafting | NEW-PR5 | [D1] CATv2 §6.3 | none |
| S-0480 | Payroll monitoring alerts | Funding shortfall; terminated still paid. NEW-PR6. | [D1] CATv2 §6.3 | none |
| S-0481 | Payroll accrual at close | — | [D1] CFO Part 1 wk1 | — |
| S-0482 | Certified / union payroll | Defer to provider | [D1] GAP §3C #25 | T2–3; missing |
| S-0483 | Provider-agnostic payroll engine + run state machine + GL post | `PayrollEngine` (mock + Check adapter); `lib/payroll/run.ts`; balanced dimensioned GL `entry_type='PAYROLL_RUN'`; SoD preparer ≠ approver; release is the only money step; provider is always the regulated party | [D2] FTP §4 | Phase A BUILT; Phase B (live provider, releaser ≠ preparer, webhooks) gated on Check vs Gusto pick |
| S-0484 | Hours / pay-register / W-2 extraction at onboarding | From timesheets and prior provider (PII stays with provider) | [D2] FTP §4 M1 | NONE ⭐NEW |
| S-0485 | Labor → job/dept/class attribution | Dimension stamp per pay line from time entries/history; earnings/deduction classification | [D2] FTP §4 M2 | spec ⭐NEW; Payroll top-3 (b) |
| S-0486 | Pay register / native branded pay-stub PDF; off-cycle / correction run draft | Drafting | [D2] FTP §4 M6 | NONE ⭐NEW (v2) |
| S-0487 | Labor-cost variance narrative + effective burden-rate readout | Reporting only, NOT the retired overhead engine | [D2] FTP §4 M7 | NONE ⭐NEW |
| S-0488 | NL payroll | "Run payroll for biweekly"; "why did Jordan's check change?" | [D2] FTP §4 M8 | → nl-copilot |
| S-0489 | Payroll close orchestration | Draft → provider preview (gross-to-net) → SoD approve → release → post → reconcile → period-spanning accrual JE | [D2] FTP §4 M9 | partial ⭐NEW |
| S-0490 | Payroll money-safety governance | No auto-run switch ever; release is explicit and logged; drafter ≠ releaser | [D2] FTP §4 M10 | partial (Phase A) |
| S-0491 | Payroll recommendations | Timing/funding optimization; garnishment routing (2270); benefit-plan/classification; contractor vs employee (1099 vs W-2) flag | [D2] FTP §4 M11 | NONE ⭐NEW |
| S-0492 | Payroll proactive alerts | Pay-run due; funding shortfall vs bank; terminated-still-paid; garnishment change; filing deadline | [D2] FTP §4 M12 | NONE ⭐NEW |
| S-0493 | Payroll policy / multi-state withholding Q&A; prior-run retrieval | Retrieval | [D2] FTP §4 M13 | NONE ⭐NEW |
| S-0494 | Per-employee comp memory + anomaly baselines | Recurring earnings/deductions, default dimensions | [D2] FTP §4 M14 | partial |
| S-0495 | Payroll-tax filings (941/940, state UI, W-2, new-hire) | Owned by payroll provider; consumed as nexus and book-to-tax facts | [D2] TAX 1.9 | Provider-owned (GATE 12.3) |

## Expenses

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 299 | Formal expense report creation (group expenses into report) | Group expenses into a formal report | Audit #299 (Cat 14); BuildSpec v4.3 §04, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P5-LOWER |
| 300 | Expense report multi-level approval chains |  | Audit #300 (Cat 14); BuildSpec v4.3 §04, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P5-LOWER |
| 301 | Expense policy engine (rules by category, amount, role) |  | Audit #301 (Cat 14); BuildSpec v4.3 §04, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P5-LOWER |
| 302 | Spending limits by employee/department/category |  | Audit #302 (Cat 14); BuildSpec v4.3 §04, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P5-LOWER |
| 303 | Out-of-policy flagging with exception workflow |  | Audit #303 (Cat 14); BuildSpec v4.3 §04, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P5-LOWER |
| 304 | Per diem auto-calculation (GSA/IRS rates) | GSA/IRS per diem | Audit #304 (Cat 14); BuildSpec v4.3 §04, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P5-LOWER |
| 305 | Mileage tracking and reimbursement (IRS standard rate) | IRS standard mileage rate | Audit #305 (Cat 14); BuildSpec v4.3 §04, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P5-LOWER |
| 306 | Cash advance tracking |  | Audit #306 (Cat 14); BuildSpec v4.3 §04, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P5-LOWER |
| 307 | Reimbursement processing (direct deposit to employee) | Direct deposit reimbursement to employee | Audit #307 (Cat 14); BuildSpec v4.3 §04, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P5-LOWER |
| 308 | Spend analytics by category/dept/vendor/employee/period | By category/dept/vendor/employee/period | Audit #308 (Cat 14); BuildSpec v4.3 §04, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P5-LOWER |
| S-0496 | Expense management | Audit category 14 (#289–308); replaces Concur | [H] D40 Part VII GATE 8; D30; D20 | GATE 8 OPEN |
| S-0497 | Expense-policy AI compiler | Plus rule-based enforcement | [H] S45 §2 | Built |
| S-0498 | EC-14 out-of-policy-expense detector | — | [H] S48 §2 | Built |
| S-0499 | Approver queue + reimbursement batch | — | [H] S49 §2 | Built |
| S-0500 | Subscription analytics | Run-rate, cost creep, renewals, triage | [H] S49 §2 | Built |
| S-0501 | Expense-policy / out-of-policy detection | NEW-EX1 | [D1] CATv2 §6.2; MATRIX §3c; [D2] P2P S8 M4 | High; none; Top30 #27; NONE ⭐NEW; "highest-value miss" |
| S-0502 | Expense accrual / spend forecast | NEW-EX2 | [D1] CATv2 §6.2; [D2] P2P S8 M5 | none; NONE ⭐NEW |
| S-0503 | Expense-report / reimbursement drafting | NEW-EX3 | [D1] CATv2 §6.2 | none |
| S-0504 | Uncoded-card / missing-receipt / policy-breach aging alerts | NEW-EX5 | [D1] CATv2 §6.2 | none |
| S-0505 | Receipt ↔ card ↔ bill 3-way match with a capture → reimburse agent | — | [D1] MATRIX §4 #27 | none |
| S-0506 | Ramp owns cards, card controls, policy agent and reimbursements | Books owns the ledger side | [D1] GAP §2 | T1 decision |
| S-0507 | Employee expense-report / card-issuance / policy / mileage / per-diem / reimbursement model | Structural gap noted | [D2] P2P S8 intro | Not present |
| S-0508 | Expense report / reimbursement summary + policy-exception drafting | Drafting | [D2] P2P S8 M6 | NONE ⭐NEW |
| S-0509 | Card-spend narrative | e.g. "$6.2k on shared card: 60% job material, 2 uncoded, 1 over-limit" | [D2] P2P S8 M7 | NONE ⭐NEW |
| S-0510 | NL expense query | "Uncoded receipts >$75 with no match this month" | [D2] P2P S8 M8 | NONE ⭐NEW |
| S-0511 | Reimbursement SoD (submitter ≠ approver) + autonomy dial | Reuses the money-movement spine | [D2] P2P S8 M10 | partial |
| S-0512 | Card-program optimization | Rebate; right card | [D2] P2P S8 M11 | NONE ⭐NEW |
| S-0513 | Expense policy / prior-approval retrieval | "Is this category allowed; who approved last" | [D2] P2P S8 M13 | NONE ⭐NEW |
| S-0514 | Per-employee / per-card coding memory | Learning | [D2] P2P S8 M14 | NONE ⭐NEW |

## Bank reconciliation

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 79 | Bank reconciliation workflow (start → match → clear → finish) | Start → match → clear → finish (Sage bank transaction assistant). MD9 note: reconciliation page wired | Audit #79 (Cat 4); BuildSpec v4.3 §04 Banking, §06; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶; seq P1-HIGH |
| 80 | Auto-matching rules (configurable field matching) | Configurable field-matching rules | Audit #80 (Cat 4); BuildSpec v4.3 §04 Banking, §06; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH |
| 84 | Reconciliation history and reports | Reconciliation history + reports | Audit #84 (Cat 4); BuildSpec v4.3 §04 Banking, §06; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH |
| 85 | Reclassify GL accounts post-reconciliation (if period open) | Reclassify GL after reconciliation if period open | Audit #85 (Cat 4); BuildSpec v4.3 §04 Banking, §06; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH |
| S-0515 | Reconciliation modal: pick statement month, enter ending balance + outstanding deposits/checks; GL cash balance computed server-side; difference; reconciled when zero |  | MD9 XI.12 | BUILT (basic) |
| S-0516 | AI reconciliation co-pilot: explain breaks and propose correcting entries for approval |  | Posting Engine Spec Part H | New AI capability |
| S-0517 | Bank & statement automation: auto-reconciliation, statement import, near-hands-off |  | Posting Engine Spec Part I #10 | BUILD |
| S-0518 | Reconciliation autopilot | Composite scorer proposes bank ↔ bill matches; Accept stages AP settlement; Reject flags; auto-clear | [H] S40 §2; [D1] CATv2 BC-B2; CATv1 D2; BKP CORE-7; [D2] BC Group B; GLC D1; R2R S3 M3 | Built; High 3.90; built; FPB-bank-reconciliation (Gate 8); BUILT (browser-verify open, task #18) |
| S-0519 | Bank rec Wave A | Per-line check-off, running difference to $0, finalize/lock, auditable un-reconcile | [H] S41 §2 (mig 065); [H] S42 §2; S46 §5 (mig 099 / 100) | Built |
| S-0520 | Outstanding-item aging + difference decomposer | Shows the leftover "plug" amount | [H] S49 §2 | Built |
| S-0521 | Read-only reconciliation history | Uses the admin client for display names | [H] S49 §2 | Built; security review flagged |
| S-0522 | Reverse-direction in-transit items | Manual JEs and Stripe AR_COLLECTION not yet surfaced | [H] S40 §4 | Open |
| S-0523 | Bank statement upload and parse | Source file stored | [H] S48 §2 | Built (AI down) |
| S-0524 | Bank rec to "Complete" | FPB written | [H] S41 §5; ANCHOR §5 | GATE 8 OPEN |
| S-0525 | Statement reconciliation with per-line check-off to $0 | Human sign-off; must reach true zero. BC-B1. | [D1] CATv2 BC-B1; MGR A2 | High 3.55; partial; Top30 #9 |
| S-0526 | Per-line cleared/reconciled linkage with finalize / lock / undo | BC-B3 | [D1] CATv2 BC-B3 | High 3.45; partial |
| S-0527 | In-rec adjusting entries | Bank fees, interest, errors. BC-B4 / BC-E7. | [D1] CATv2 BC-B4 | Med 3.20; built |
| S-0528 | "Find the difference" AI diagnosis | E.g. "likely bank fee not booked, $36". BC-B5. | [D1] CATv2 BC-B5; BKP CORE-7; [D2] BC Group B; R2R | Med 3.05; none; MISSING; deferred |
| S-0529 | Unreconcile / undo with audit trail | BC-B6 | [D1] CATv2 BC-B6; [D2] BC Group B | Med 2.95; none; MISSING; Tier 1 #1 |
| S-0530 | Statement import (CSV/OFX/QFX) plus manual line entry | BC-B7 | [D1] CATv2 BC-B7; [D2] BC Group B; P2P S3 M1 | High 3.20; none; MISSING; Tier 1 #3 |
| S-0531 | Split/grouped deposits and inter-account transfer detection | BC-B9 | [D1] CATv2 BC-B9; [D2] BC Group B; P2P S3 M3 | Med 3.05; none; MISSING |
| S-0532 | Reconciliation report (PDF) with stale-check aging | BC-B10 | [D1] CATv2 BC-B10 | Med 3.00; none |
| S-0533 | Reconciliation-required close gate (auto-verified) | No HARD_CLOSE until every active bank account reconciles to $0; auto-verified; override with reason (BC B11) | [D1] CATv2 BC-B11; [D2] BC Group B | High 3.55; partial; PARTIAL; Tier 1 #2 |
| S-0534 | Statement-PDF OCR with ending-balance anchor | Anchors a rec with no feed | [D1] CATv2 §6.1; [D2] R2R S3 M1 | none; partial ⭐NEW |
| S-0535 | Plug / stale-item detector | Canon §1.5 #12. NEW-RC2. | [D1] CATv2 §6.1; MGR A2; [D2] R2R S3 M4; GLC 1.5 | none; spec ⭐NEW; R2R S3 #2 |
| S-0536 | Predicted clearing dates | NEW-RC3 | [D1] CATv2 §6.1; [D2] R2R S3 M5 | none; spec ⭐NEW |
| S-0537 | Reconciliation-memo drafting | NEW-RC4 | [D1] CATv2 §6.1; [D2] R2R S3 M6 | none; ⭐NEW |
| S-0538 | Reconciliation evidence pinned to the bank-statement PDF | Plus "these ledger lines broke a reconciled account" | [D1] GAP §3B #12 | T2; missing |
| S-0539 | Bank-fee anomaly / analysis-statement audit | BC-E5 | [D1] CATv2 BC-E5 | Med 2.95; none |
| S-0540 | NSF / return / overdraft tracking | Reverses the cash application and re-opens the invoice. BC-E6. | [D1] CATv2 BC-E6 | Med 3.05; none |
| S-0541 | Unreconciled-item aging and float | BC-F5, BC-F4 (segment tail) | [D1] CATv2 §2.5 note; CFO #7 | low |
| S-0542 | Continuous three-way tie: bank feed ↔ GL ↔ subledger | — | [D1] CFO #7 | — |
| S-0543 | Every balance-sheet account reconciled | Credit cards, loans, payroll clearing, intercompany, suspense/clearing | [D1] CFO wk1; MGR A2 | — |
| S-0544 | Statement reconciliation (controller flow) | Statement ending balance + outstanding items; server GL cash as-of; difference = GL − adjusted; `is_reconciled` at 0; per-line check-off with running diff-to-$0; explicit finalize/lock (BC B1) | [D2] BC Group B | PARTIAL (totals-only modal); BC Tier 1 #1 |
| S-0545 | Per-line cleared/reconciled linkage | `reconciliation_id` + `reconciled_at` (mig 065); enables line audit, finalize-lock, unreconcile (BC B3) | [D2] BC Group B | BUILT data model; UI partial; Tier 1 #1 |
| S-0546 | In-reconciliation adjusting entries | Bank fee / interest / error; direction from account type; respects period lock; mirrored as a bank line so it clears (BC B4) | [D2] BC Group B; R2R S3 M6 | BUILT |
| S-0547 | Reconciliation report PDF + outstanding-items aging | Beginning balance, cleared deposits/checks, ending, outstanding, book balance, difference (BC B10) | [D2] BC Group B; P2P S3 M6 | MISSING; Tier 1 #4 |
| S-0548 | Unreconciled-aging control | Continuous feed ↔ GL ↔ subledger tie; ages items; flags drift (BC F5) | [D2] BC Group F; R2R S3 M12 | PARTIAL |
| S-0549 | Reconciling-items narrative | Explains each open item | [D2] R2R S3 M7 | spec ⭐NEW |
| S-0550 | NL "reconcile this account" | Conversational | [D2] R2R S3 M8 | spec ⭐NEW |
| S-0551 | Best-match / bulk-clear suggestion | Ranked candidates | [D2] R2R S3 M11 | partial |
| S-0552 | Retrieve source doc for a bank line | Invoice/bill/receipt | [D2] R2R S3 M13 | spec ⭐NEW |
| S-0553 | Disbursement-to-bank reconciliation (AP clearing) | Matches payments to bank debits; uncleared/stale checks (AP G1) | [D2] AP Group G; P2P S7 M3 | PARTIAL |

## Close (month-end, year-end, working papers, controls)

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 121 | Cross-entity progress table (17 entities × 3 phases) | Each entity × 3 phases (Initial day 3 / Mid day 7 / Final day 10). MD9 note: close page wired; close_checklists | Audit #121 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶; seq P3-MED |
| 122 | Initial Close checklist (Due Day 3): issue sales invoices | MD9 note: items not individually tracked | Audit #122 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 123 | Initial Close: verify bank feed posted (auto-verified ⚡) | Auto-verified: no unposted bank feed items. MD9 note: items not individually tracked | Audit #123 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 124 | Initial Close: reconcile all cash/credit/fuel accounts | MD9 note: items not individually tracked | Audit #124 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 125 | Initial Close: reconcile payroll liabilities to $0 | MD9 note: items not individually tracked | Audit #125 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 126 | Initial Close: save AP summary report (auto-verified: AP aging = BS AP) | Auto-verified: AP aging = balance sheet AP. MD9 note: items not individually tracked | Audit #126 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 127 | Mid-Close checklist (Due Day 7): depreciation posted |  | Audit #127 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 128 | Mid-Close: prepaids amortized |  | Audit #128 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 129 | Mid-Close: Rev Rec entered |  | Audit #129 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 130 | Mid-Close: 10-10-10 deferred revenue calculated |  | Audit #130 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 131 | Mid-Close: bonus accrual booked |  | Audit #131 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 132 | Final Close checklist (Due Day 10): management review |  | Audit #132 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 133 | Final Close: variance analysis |  | Audit #133 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 134 | Final Close: financial statement preparation |  | Audit #134 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 135 | Auto-verification badges (⚡) on system-confirmable items | ⚡ badge on items the system confirms from GL data | Audit #135 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 136 | Working papers — balance sheet account documentation | 112 material BS accounts, balances vs prior, sub-ledger status, open items. MD9 note: working_papers table exists | Audit #136 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 137 | Working papers — preparer + reviewer sign-off | MD9 note: working_papers fields | Audit #137 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ⬜; seq P3-MED |
| 138 | Working papers — 5 tickmarks (✓ Σ ◊ ↕ T) | ✓ Agreed to Source, Σ Footed, ◊ Recalculated, ↕ Cross-referenced, T Traced to GL | Audit #138 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 139 | Period Close Gate (all checks must pass) | All checks must pass before period close. MD9 note: trigger exists; no gate UI | Audit #139 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 140 | Period Close Gate — bank rec complete check |  | Audit #140 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 141 | Period Close Gate — checklist complete check |  | Audit #141 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 142 | Period Close Gate — working papers approved check |  | Audit #142 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 143 | Period Close Gate — open items resolved check |  | Audit #143 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 144 | Period Close Gate — compliance current check |  | Audit #144 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 145 | Period Close Gate — intercompany balanced check |  | Audit #145 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 146 | Period Close Gate — manager override with documented reason | Override with documented reason, audit-logged | Audit #146 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| S-0554 | Working papers detail: 112 material accounts by category; account, type (Cash/AR/Prepaid/PP&E/AP/Payroll/Debt/Accrued/Equity), current & prior balance, change, sub-ledger status (bank rec/AR aging/schedule/variance), open items count |  | BuildSpec v4.3 §13 |  |
| S-0555 | Close checklist auto-generated from templates; task assignment, dependencies, sequencing | Dependencies missing per §04 | BuildSpec v4.3 §04 |  |
| S-0556 | File review checks: expense inconsistencies vs history; uncategorized/missing payees; duplicates; stale AR/AP >90 days; unbalanced intercompany; GL-to-subledger variance; bank rec status | Double-style "file review" | BuildSpec v4.3 §04 Month-End Close |  |
| S-0557 | Year-end close per entity: temporary accounts → Retained Earnings (3020) as one CLOSING entry; preview/run/reverse; /year-end-close | Custom fiscal year-ends not modeled (Dec 31 only) | MD9 XI.9 (mig 038) | BUILT |
| S-0558 | Continuous autonomous close agent (9a): daily drafting of recurring close entries, cash/sub-ledger reconciliation, flux/variance with narrative, per-entity close-readiness score |  | MD9 GATE 9a | OPEN |
| S-0559 | Continuous controls/self-audit (9a): TB ties, control accounts reconcile, eliminations net zero, no orphans/out-of-period entries, dimensions present; never "all clear" while a tie is broken |  | MD9 GATE 9a | OPEN |
| S-0560 | Period-end adjusting entries: accrued expenses (auto-reverse next period), accrued/unbilled revenue, prepaid amortization, depreciation, deferred revenue recognition, allowances & reserves — drafted by continuous-close agent |  | Posting Engine Spec B10 |  |
| S-0561 | Close checklist templates that seed checklist items per period; toggle items in 3-phase grid with progress bars |  | Handoff S9 §4 | P2 |
| S-0562 | Month-end close + Period Close Gate | 3 phases; gate checks bank recs, checklist, working papers, open items, compliance, intercompany; manager override needs a reason | [H] D40 Part VIII | Canon |
| S-0563 | Period status per location per month | OPEN / SOFT_CLOSE / HARD_CLOSE; database blocks posting to closed periods | [H] CLAUDE.md; D20 | Built |
| S-0564 | Periods created at setup | From fiscal-year start month; never auto-created at posting | [H] D10 | Canon |
| S-0565 | Events into closed periods rejected | Originator queues or flags | [H] D10 Matrix rule F | Canon |
| S-0566 | Year-end close to retained earnings | Per entity, zeroes P&L to Retained Earnings (3020) via one `CLOSING` entry; idempotent, reversible, re-runnable (GLC I1) | [H] D40 Part III (mig 038); [D1] CATv2 GL-I1; [D2] GLC Group I | Built; Med 3.20; built; LIVE (mig 038) |
| S-0567 | Close Command Center | Live state for each entity × workstream (bank rec, AR, AP, payroll, accruals, IC, review, sign-off), derived from the ledger. Shows % complete, blockers, waiting-on-client, risk vs calendar, and machine vs human owner per cell. Missing signal shows "unknown", never a false green. D3 / GL-F1. | [H] S42 §2; [D1] CATv1 D3; CATv2 GL-F1; MGR B1; CFO #9; [D2] GLC Group F | Built; High 3.95; built (CATv2) / not built (COV); LIVE (`/close-status`) |
| S-0568 | Close orchestration | Ordered task graph, live auto-verify, blocking hard-close gate | [H] S45 §2 | Built |
| S-0569 | Close-readiness checklist + close package | — | [H] S49 §2 | Built |
| S-0570 | EC-4 leakage blocks clean close | Above $25k | [H] S41 §2 | Built |
| S-0571 | Continuous autonomous close + controls/fraud | GATE 9a | [H] D40 Part VII | OPEN |
| S-0572 | Close-run agent recipe (M9) | — | [H] S46 §4 (task #105) | Next |
| S-0573 | Close start/end timestamps | Feed days-to-close KPI | [H] S42 (mig 074) | Built |
| S-0574 | Uncategorized / "Ask My Accountant" cleanup with empty-before-close gate | Re-proposes coding as new context arrives; blocks HARD_CLOSE while the queue is non-empty. D1 / GL-C4 / CORE-8. | [D1] CATv1 D1; CATv2 GL-C4; BKP CORE-8; CFO #4 | High 4.05; built (detect feeds close); v2-BN #16 |
| S-0575 | Close-task orchestration with a dependency graph | GL-F2 | [D1] CATv2 GL-F2; [D2] GLC Group F | Crit 3.80; partial; Top30 #7; PARTIAL; GLC #2 (Close Orchestration FPB) |
| S-0576 | Auto-verify mechanical close tasks from the ledger | E.g. "bank rec = 0 ✓". GL-F3. | [D1] CATv2 GL-F3; CFO #9; [D2] GLC Group F | High 3.65; partial; PARTIAL; GLC #2 |
| S-0577 | Continuous ("soft") close with days-to-close-ready | GL-C1; ETA = NEW-CL2 | [D1] CATv2 GL-C1, §6.1 | High 3.60; partial |
| S-0578 | Close-binder document OCR | NEW-CL1 | [D1] CATv2 §6.1; [D2] R2R S2 M1 | none; spec ⭐NEW |
| S-0579 | Close-path / critical-path optimization | NEW-CL3 | [D1] CATv2 §6.1; [D2] R2R S2 M11 | none; spec ⭐NEW; R2R S2 #2 |
| S-0580 | Close-deadline / phase-slip alert | NEW-CL4 | [D1] CATv2 §6.1; [D2] R2R S2 M12 | none; spec ⭐NEW; R2R S2 #3 |
| S-0581 | Close analytics | Cycle time, bottlenecks, autonomy rate → feeds the autonomy dials. GL-I3. | [D1] CATv2 GL-I3 | High 3.30; none |
| S-0582 | Prior-period adjustment / controlled-reopen workflow with alarm | Edits to closed periods become approval-queued proposals | [D1] CATv2 GL-I2; GAP #11; MGR A7; [D2] GLC Group I; GLC 1.5 #13 | High 3.45; partial; PARTIAL (lock + reason); GLC #6 |
| S-0583 | Group close gate | The group month closes only when every entity has closed. Bottleneck-by-entity view. Auto post-close package (P&L / BS / cash vs budget plus reforecast). | [D1] GAP §3A #5 | T1 Now; partial |
| S-0584 | Plain-English close procedure run by agents | Agents run each step, pause for approval and replay monthly; checklist rows trigger agents | [D1] GAP §3B #9 | T2; partial |
| S-0585 | Structured close checklist per entity | Owner, preparer/reviewer, due date, status, linked evidence; 80–200 items | [D1] CFO #9 & Part 1 | — |
| S-0586 | Close sign-off criteria and period lock | All accounts reconciled, items explained, accruals and cutoff in, IC eliminates, flux story complete, review notes cleared → lock | [D1] MGR A7 | — |
| S-0587 | Missing-variance-explanation detector as a close gate | Close can't sign while a material variance lacks a story (GLC E2, FPA D3) | [D1] CATv2 FP-D3, GL-E2; [D2] GLC Group E; FPA Group D; FTP §1 M4 | High 3.40; none; Top30 #6; NOT BUILT (depends on flux narrative) |
| S-0588 | Subledger → GL control-account tie-out (standing control) | AR = 1100, AP = 2000, payroll clearing = 0, CC liability ties to statement; block sign-off while unapplied cash or variance exceeds threshold (AR C35, AP H2, GLC D2) | [D1] CATv2 GL-D2; [D2] AR Group F; AP Group H; GLC Group D; R2R S2 M3 | High 3.55; partial; MISSING/PARTIAL; AR Tier 1 #1 |
| S-0589 | Working papers auto-generated with tie-out | GL-G1 | [D1] CATv2 GL-G1 | High 3.70; partial; Top30 #21 |
| S-0590 | Roll-forward schedules | Prepaids, accruals, deferred revenue, debt, fixed assets, equity. GL-G2. | [D1] CATv2 GL-G2; CFO #8; [D2] GLC Group G | High 3.30; none; NOT BUILT; GLC #5 |
| S-0591 | Accrue unsynced Ramp spend at month-end | — | [D1] GAP §2 | T1 |
| S-0592 | Review notes / points loop | Preparer must clear review points before sign-off | [D1] FIRM A6; MGR A2 | — |
| S-0593 | Phased close pipeline | INITIAL / MID_CLOSE / FINAL with `due_day` 3/7/10 per entity + group consolidation phase | [D2] GLC 1.1 | Encoded in `close_checklists` |
| S-0594 | Workload / capacity view | Exception/review queue counts + aging by entity/workstream/tier/assignee; throughput vs inflow; time-to-clear vs calendar (GLC F4) | [D2] GLC Group F | PARTIAL; GLC #2 |
| S-0595 | Continuous / soft close orchestration | Close-ready all month; live "days-to-close-ready" number (GLC C1) | [D2] GLC Group C | PARTIAL |
| S-0596 | Missed-accrual detection + auto-draft (EC-2) | Signals: vendor recurrence gone silent / recurring template due but not run / scheduled deferral missing; drafts balanced accrual with basis; idempotent (GLC B1) | [D2] GLC Group B; R2R S1 M5, S2 M4 | LIVE |
| S-0597 | Cutoff-error detection (EC-12) | Near period end, compares invoice/bill date vs delivery/performance evidence; honors deferral rule (TAX F2) | [D2] TAX Group F; GLC 1.5 #5 | BUILT detect-only |
| S-0598 | Uncategorized / suspense leakage control (EC-4) | Ages uncoded/suspense; feeds close-status; empty-before-close gate (BC F7) | [D2] BC Group F; GLC 1.5 #4; R2R S2 M2 | BUILT detect-only |
| S-0599 | Anomaly-by-shape (analytical review as a control) | Margin drift; expense line suddenly empty; revenue in the wrong period (GLC E3) | [D2] GLC Group E | PARTIAL; GLC #4 |
| S-0600 | Working-paper auto-generation + tie-out | Per BS account: GL vs support, variance, tickmarks, doc links, preparer/reviewer sign-off; pre-filled from recs/subledgers (GLC G1) | [D2] GLC Group G; GLC 1.2 | PARTIAL (schema mig 007); GLC #5 |
| S-0601 | Audit-ready evidence packaging | One-click bundle per period/entity: recs, working papers, JE support, approval chain, Decision Log of AI vs human (GLC G3) | [D2] GLC Group G | NOT BUILT; GLC #5 |
| S-0602 | Adjusting-entry batch draft | Standard month-end accrual/deferral/depreciation set | [D2] R2R S2 M6 | partial |
| S-0603 | Days-to-close-ready ETA prediction | From queue burn-down | [D2] R2R S2 M5 | spec ⭐NEW; R2R S2 #2 |
| S-0604 | "Why is this entity red" narrative | Explains blockers | [D2] R2R S2 M7 | spec ⭐NEW |
| S-0605 | "What's blocking close" NL | Conversational | [D2] R2R S2 M8 | spec ⭐NEW |
| S-0606 | Search close binder / prior-period support | Last quarter's accrual basis, prior working papers | [D2] R2R S2 M13 | spec ⭐NEW |
| S-0607 | Learn tenant close cadence + typical accrual set | Learning | [D2] R2R S2 M14 | spec ⭐NEW |

## GL / journal entries / COA (incl. split transactions)

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 1 | Multi-dimensional GL with 4 dimensions (Location, Dept, Class, Item) | MD9 note: 002_dimensions.sql; gl_entry_lines FKs | Audit #1 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: BUILT; MD9: ✅ |
| 2 | Unified COA using dimensions instead of account proliferation | MD9 note: 003_chart_of_accounts.sql | Audit #2 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: BUILT; MD9: ✅ |
| 3 | 251 seed accounts from Merit Top Level COA | MD9 note: template encodes 137 (not 251); seeding now lands the full template idempotently; prod backfilled | Audit #3 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: SCHEMA; MD9: 🔶 |
| 4 | Real-time posting from sub-ledgers (AP, AR, payroll, fixed assets) | Sub-ledgers (AP, AR, payroll, fixed assets) post to GL in real time. MD9 note: gl-posting.ts; only manual JE so far | Audit #4 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶 |
| 5 | Multi-book support (GAAP, tax, cash, accrual simultaneously) | GAAP / tax / cash / accrual simultaneously (Sage). Later decision: cash basis = reporting layer only; dual-book only for depreciation (MD9 X.1). MD9 note: no book_type field | Audit #5 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 6 | Continuous close (close sub-ledgers independently) | Close sub-ledgers independently of the GL period. MD9 note: fiscal_periods + enforce_period_lock() | Audit #6 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶 |
| 7 | Statistical accounts and statistical journals | MD9 note: gl_entries.entry_type=STATISTICAL | Audit #7 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ⬜ |
| 8 | Account groups with independent display_order (Accounting Mgr request #2) | MD9 note: 001_foundation.sql. Spec: display_order at type/sub-type/group; new accounts inserted at a specified position within their group, not appended | Audit #8 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V; BuildSpec v4.3 §05 (Acct Mgr feedback #2) | Apr-26 audit: BUILT; MD9: ✅ |
| 9 | COA approval workflow — Request → Approve → Activate (Accounting Mgr request #3) | MD9 note: enforce_coa_approval() | Audit #9 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: BUILT; MD9: ✅ |
| 10 | COA tree view in UI | MD9 note: chart-of-accounts/account-tree.tsx | Audit #10 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: BUILT; MD9: ✅ |
| 11 | Journal entry templates for non-accountants (Claude NL-to-JE) | NL-to-JE composer for non-accountants; MD9 II.5 makes it CORE with downstream actions (queue check, schedules, recurring). MD9 note: NOW CORE (II.5) | Audit #11 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 12 | Journal entry approval workflows (sequential approvers) | Sequential approvers on JEs. MD9 note: gl_entries.status; no approver chain | Audit #12 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶 |
| 13 | Journal entry import from spreadsheets | Import JEs from CSV/XLSX | Audit #13 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 14 | Recurring journal entries with reversing flag | Templates: frequency monthly/quarterly/annually, start/end, reversing flag, full dimensions. MD9 note: recurring page wired; recurring_templates. Spec: Templates; each period propose → approve → post | Audit #14 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V; [H] S45 §2 (mig 093) | Apr-26 audit: SCHEMA; MD9: 🔶; Built (legacy `/recurring` to remove) |
| 15 | Adjusting entries via Period 13 | Period 13 for adjusting entries. MD9 note: period_number 1-13 | Audit #15 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶 |
| 16 | Year-end closing entries to Retained Earnings | Close temporary accounts to Retained Earnings per entity (built S22 as year-end close). MD9 note: closes_to_retained_earnings flag only | Audit #16 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 18 | Reporting accounts (alternate COAs for different standards) | Alternate COAs for different reporting standards | Audit #18 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 19 | AI outlier detection on posted journal entries | AI outlier/anomaly detection on posted JEs (Sage Copilot parity) | Audit #19 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 20 | Required dimension enforcement per account/location | MD9 note: require_department/class/item + validate_dimensions() | Audit #20 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: BUILT; MD9: ✅ |
| 21 | Field-level audit trail — who/when/what changed per JE (Accounting Mgr request #1) | Who/when/what changed per JE, field-level old→new, user, IP. MD9 note: audit_log + v_journal_entry_audit | Audit #21 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: BUILT; MD9: ✅ |
| 22 | Opening balance entry workflow | Opening balance wizard / entry type (see MD9 II.7 Step 5 conversion) | Audit #22 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 23 | 7 account types with number ranges (10000-99999) | MD9 note: account_types | Audit #23 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: BUILT; MD9: ✅ |
| 24 | 11 account sub-types | MD9 note: account_sub_types | Audit #24 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: BUILT; MD9: ✅ |
| 25 | 71 account groups | MD9 note: account_groups | Audit #25 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: BUILT; MD9: ✅ |
| 26 | Control account protection (no manual posting) | MD9 note: enforce_control_accounts() | Audit #26 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: BUILT; MD9: ✅ |
| 27 | Company-specific account isolation | MD9 note: is_company_specific + trigger | Audit #27 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: BUILT; MD9: ✅ |
| 175 | Journal Entries — Create/review/post manual JEs | MD9 note: wired + je-form | Audit #175 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅; seq P3-MED |
| 176 | Journal Entries — Draft/Posted/All tabs | MD9 note: wired + je-form | Audit #176 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅; seq P3-MED |
| 177 | Journal Entries — Balanced DR/CR line items mapped to GL accounts | MD9 note: wired + je-form | Audit #177 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅; seq P3-MED |
| 178 | Journal Entries — Entry types: STANDARD, RECURRING, REVERSING, STATISTICAL, CLOSING, SUB_LEDGER | MD9 note: enums exist | Audit #178 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ⬜; seq P3-MED |
| 179 | Journal Entries — Source modules: MANUAL, AR, AP, CASH_MGMT, FIXED_ASSETS, PAYROLL, INVENTORY, SYSTEM | MD9 note: enums exist | Audit #179 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ⬜; seq P3-MED |
| 183 | Recurring Transactions — Auto-generated entries per period | MD9 note: recurring page wired | Audit #183 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: ✅/⬜; seq P3-MED |
| 184 | Recurring Transactions — Frequency (monthly/quarterly/annually) | MD9 note: recurring page wired | Audit #184 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ✅/⬜; seq P3-MED |
| 185 | Recurring Transactions — Reversing flag | MD9 note: recurring page wired | Audit #185 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ✅/⬜; seq P3-MED |
| S-0608 | Unified master COA shared by all companies; only cash, credit-card and bank-debt accounts are company-specific | Company-specific accounts flagged is_company_specific + company_location_id; appear only in that company's TB/reports, never as zero rows elsewhere | BuildSpec v4.3 §05 |  |
| S-0609 | "Request Account" button for non-approvers; approver queue (Acct Mgr, CFO, Org Admin); rejection reason; approval logged | approval_status DRAFT/PENDING/APPROVED/REJECTED; only APPROVED accounts accept postings (trigger) | BuildSpec v4.3 §05 (Acct Mgr feedback #3) |  |
| S-0610 | JE audit timeline view: who created, each field edit old→new, who posted | audit_log append-only, joined to gl_entries/lines; per-entry, per-field, per-user drill-down | BuildSpec v4.3 §05 (Acct Mgr feedback #1) |  |
| S-0611 | Company-specific account isolation trigger; unique account numbers incl. company-specific | isolate_company_accounts(); no duplicate account_number | BuildSpec v4.3 §05, §18 |  |
| S-0612 | Intercompany due-from/due-to accounts flagged is_intercompany for elimination engine |  | BuildSpec v4.3 §05 |  |
| S-0613 | Closing behavior per account: CLOSING / NON_CLOSING / CLOSED_TO with close-into account (Retained Earnings 39990) |  | BuildSpec v4.3 §05 |  |
| S-0614 | Income statement structure: Revenue − COGS = Gross Profit − OpEx = EBITDA − Other (Income) Expense = Net Income | OpEx (6000s) vs Other (70000+) distinction is mandatory | BuildSpec v4.3 §05 |  |
| S-0615 | Fiscal years and periods per Location; periods 1–13 with OPEN/CLOSED/LOCKED status |  | BuildSpec v4.3 §18 |  |
| S-0616 | Six DB enforcement triggers: balance, period lock, control accounts, company isolation, dimensions (stricter of account vs location wins), COA approval | "Application bugs cannot produce corrupt books" | BuildSpec v4.3 §03, §05, §18 |  |
| S-0617 | Recurring transaction templates: frequency monthly/quarterly/annually, start/end dates, reversing flag, line detail with full dimensions | Examples: office lease, GL insurance, vehicle leases, software subscriptions, loan payments, monthly depreciation | BuildSpec v4.3 §10 |  |
| S-0618 | Per-tenant COA: standard 251-account template is a seed, tenant may use standard, bring own, or merge | Spec'd 251; template currently encodes 137 accounts (114 untranscribed) — accepted for now | MD9 I.5, III.2, XI.6 |  |
| S-0619 | Company → Department → Job hierarchy; departments fully user-defined (none seeded); each department has own P&L, budget and FP&A; jobs live under departments when company has >1 department | Departments support parent hierarchy | MD9 II.1–II.2 | BUILT (dept model) |
| S-0620 | Edit-with-override on posted invoices/JEs: typed reason to audit log; financial change reverses and re-posts GL; drafts edit freely | Mike chose override over void/credit-memo lockout; to be role-gated once identity exists | MD9 XI.12 | BUILT |
| S-0621 | Deterministic posting engine: account-type-aware direction, 21 role keys, 31 transaction templates (direct expense, cc charge, vendor bill, bill payment, cc payment, cash sale, invoice, customer payment, bank transfer, bank fee, interest income, prepaid, asset acquisition, depreciation, owner contribution/draw, inventory purchase, vendor credit, cc refund, bad debt, customer refund, sales tax remittance, income tax accrual, loan draw/payment, accrued interest, deferred revenue, progress billing, retainage, undeposited funds, NSF reversal) | Pending: payroll remittance service, accrual, deferral, lease inception/payment, 4 reserved GATE-11 types | MD9 GATE 2 | DONE/VERIFIED |
| S-0622 | 11c Inventory costing: FIFO / average / standard; landed cost; multi-warehouse; reorder points |  | MD9 GATE 11c | OPEN |
| S-0623 | Multi-currency: inert currency/fx_rate seam only; FX gain/loss & translation deferred | The only foregone item | MD9 GATE 11 | DEFERRED (seam) |
| S-0624 | Universal override at review: every proposed transaction is a fully editable draft before posting — account, dimensions (job/department/class/item), payment rail, line SPLITS, tax, vendor/customer, dates, GAAP treatment election (defer/capitalize/prepaid/WIP) | Re-runs deterministic posting on edits; flagged-override needs reason; proposal+edits+reason to Decision Log | Posting Engine Spec Part A6, Part G | Universal control |
| S-0625 | Split a transaction / document into multiple lines across accounts and multiple jobs/dimensions on one document | "multi-line and multi-job/dimension splits on one document" | Posting Engine Spec Part E6, Part G |  |
| S-0626 | "Park until close" deferral election available at review for any revenue/receivable line (hold in Deferred Revenue, release at close) |  | Posting Engine Spec Part G |  |
| S-0627 | Payment rail modeled as property of the event (cash, check float, ACH 1–3 day, wire + fee line, debit card, credit card payable, on-account) |  | Posting Engine Spec Part A3 |  |
| S-0628 | Lifecycle state machines: AP bill→approved→scheduled→paid; AR invoice→paid; credit card charge→statement-paid; accruals accrue→reverse — settlement clears obligation, never double-counts |  | Posting Engine Spec Part A4, E4 |  |
| S-0629 | Inventory purchase → Inventory asset; COGS relief at sale |  | Posting Engine Spec B1 |  |
| S-0630 | Policy elections are per-tenant configuration, never engine constants: capitalization threshold, lease classification, rev-rec policy, allowance method, multi-state sales tax |  | Posting Engine Spec preface |  |
| S-0631 | Job→WIP redirect when a cost is coded to a job |  | Posting Engine Spec E8 |  |
| S-0632 | Reserved transaction types for purchase_order, po_receipt, inventory_adjustment, encumbrance/commitment entries |  | Posting Engine Spec Part I |  |
| S-0633 | JE create/edit form with balanced debit/credit validation, dimension pickers, posting |  | Handoff S9 §6 | Built S10 |
| S-0634 | Fiscal periods auto-generated per company at creation: prior year HARD_CLOSE, current year past months SOFT_CLOSE, current/future OPEN, next year OPEN | OPEN / SOFT_CLOSE / HARD_CLOSE per location per month | Handoff S10 §2; CLAUDE.md | BUILT |
| S-0635 | COA "Request Account" form with account-group picker |  | Handoff S10 §4 | P2 |
| S-0636 | Double entry enforced in the database | Six triggers (balance, period lock, control accounts, company-account isolation, dimensions, COA approval) | [H] D20; CLAUDE.md | Built |
| S-0637 | Debit/credit from account type | 7 types; there is no EXPENSE type | [H] ANCHOR §2–3; D20 | Canon |
| S-0638 | Per-tenant chart of accounts | Template of 137 accounts; reference accounts by role, not number | [H] ANCHOR §2; D10 FILE 5 | Canon |
| S-0639 | Company-specific accounts | Cash, credit card, bank debt tied to a location | [H] D20 | Canon |
| S-0640 | Four GL dimensions | Location (mandatory), Department, Class, Item; stricter of account/location rules applies | [H] D20 | Built |
| S-0641 | Entry types and source modules | STANDARD, RECURRING, REVERSING, STATISTICAL, CLOSING, SUB_LEDGER; sources MANUAL, AR, AP, CASH_MGMT, FIXED_ASSETS, PAYROLL, INVENTORY, SYSTEM | [H] D20 | Canon |
| S-0642 | AI JE composer + categorizer, one engine | NL composer and inbound categorizer share one review/audit path; asks ONE clarifying question when ambiguous; non-standard GAAP flagged | [H] D40 Part II | Canon; GATE 3 build complete, live check pending |
| S-0643 | Account-role registry | Tax, lease, prepaid, intangible, disposal, bad debt, notes payable, interest roles | [H] S45 (mig 094); S46 (mig 098); S50 (mig 149) | Built |
| S-0644 | COA grouped balances + GL detail modal | `/api/accounts/balances` | [H] S49 §2 | Built |
| S-0645 | EC-10 anomalous-JE detector | Missing support, structuring, sensitive account, backdated, round dollar, after hours | [H] S41 §2 | Built |
| S-0646 | EC-2 missed accrual | Drafts the accrual JE | [H] S42 | Built |
| S-0647 | EC-12 cutoff error | Economic date vs posted period, with materiality | [H] S42 | Built |
| S-0648 | Separate internal vs external source refs | Internal uuid vs external processor id | [H] S38 §2 (mig 056) | Built |
| S-0649 | Multi-currency seam | Currency + FX rate columns present but inactive | [H] D20; D40 Part VII GATE 11 | Deferred (seam only) |
| S-0650 | Attachments on JEs | — | [H] S45 §2 | Built |
| S-0651 | Drill-down navigation | Detail drawer, hover preview, clickable rows | [H] D40 Part XI | Built |
| S-0652 | Natural-language JE composer | Plain English → balanced, role-resolved JE (`je-composer`). PW5. | [D1] CATv2 PW5; COV #1; [D2] GLC Group A; R2R S1 M2/M6 | High 3.90; built (JE part); LIVE (`je-composer.ts`) |
| S-0653 | Recurring JE auto-generation with reversing logic | GL-A2 | [D1] CATv2 GL-A2; CFO #3; [D2] GLC Group A; R2R S1 M9 | High 3.55; partial; PARTIAL (batch UI thin) |
| S-0654 | Recurring-entry batch at period open | Rent, depreciation, prepaid burn, accruals, loan splits; adjust variable amounts; release the batch. B3 / CORE-6. | [D1] CATv1 B3; BKP CORE-6 | 3.90 |
| S-0655 | Learned recurring-entry discovery ("make this recurring?") | GL-A3 | [D1] CATv2 GL-A3; [D2] GLC Group A; R2R S1 M11 | Med 3.10; partial; PARTIAL |
| S-0656 | Auto-accrual of expected-but-absent recurring costs | "The leak is the accrual you forgot." GL-B1. | [D1] CATv2 GL-B1; CFO #3 | Crit 3.90; built |
| S-0657 | Prepaid amortization / straight-line schedule engine | GL-B2 | [D1] CATv2 GL-B2 | High 3.40; partial |
| S-0658 | Depreciation and interest accrual scheduler (dual-book) | GL-B4 | [D1] CATv2 GL-B4 | Med 3.15; partial |
| S-0659 | Loan payment split into interest and principal | Driven off the amortization schedule | [D1] BKP Part 1; CATv1 B3 | — |
| S-0660 | Anomalous / unsupported JE detection (AU-C 240) | Scores every manual JE: round-dollar, weak or blank description, no attachment, odd account pair (revenue ↔ reserve), off-hours / post-close, preparer identity. Blocks high-risk entries without support above materiality. PW2 / H2 / EC-10. | [D1] CATv2 PW2; CATv1 H2; CPA B7; MGR B4; [D2] AP Group I; TAX Group F; R2R S1 M4 | Crit 4.20; built detect-only → enforce is v2-BN #23; BUILT detect-only; R2R S1 #2 "enforce" |
| S-0661 | Pre-post anomaly interceptor | Moves detectors onto the synchronous posting path; hard flags block, soft flags annotate; fail closed. PW8. | [D1] CATv2 PW8; MGR B4; [D2] GLC Group C | High 3.80; partial; Top30 #1; PARTIAL; GLC #7 |
| S-0662 | Re-expensed settlement detection | Expense debited where it should be DR AP / clear the card liability | [D1] MGR B4; CATv1 H1 | — |
| S-0663 | Duplicate-JE / reversing-pair matching | NEW-GL1 | [D1] CATv2 §6.1; [D2] R2R S1 M3 | none; partial ⭐NEW |
| S-0664 | Stuck / unposted batch monitor | NEW-GL2 | [D1] CATv2 §6.1; [D2] R2R S1 M12 | none; partial ⭐NEW |
| S-0665 | Anomaly-by-shape analytical review (ratio/trend engine) | GL-E3 | [D1] CATv2 GL-E3; MGR A2 | High 3.35; partial |
| S-0666 | Trial-balance diagnostic review | Negative balances, suspense balances, round-dollar plugs, BS not tying to prior-year ending | [D1] CPA A1 | — |
| S-0667 | Deterministic posting-engine gates | Balance, period lock, control accounts, approved COA, dimension validation, entry numbering | [D1] MGR B4; CATv2 §3; [D2] GLC C2, 1.5 #11 | built; LIVE |
| S-0668 | Required JE reason and attachment | "No JE without a reason and backup" | [D1] MGR A2; CPA B7 | — |
| S-0669 | "Explain this account's movement" GL narration | — | [D1] COV #1; MATRIX §2 (M7) | gap |
| S-0670 | Transactional multi-currency | — | [D1] GAP §3D #30 | T3, low priority |
| S-0671 | JE-support IDP | Extracts backup behind a manual JE, auto-attaches, validates the amount ties | [D2] R2R S1 M1 | spec ⭐NEW |
| S-0672 | Explain-this-JE narrative | What the entry did and why | [D2] R2R S1 M7 | partial ⭐NEW |
| S-0673 | Ask-the-ledger NL | "What's in 6100 for Heritage in Q2" | [D2] R2R S1 M8 | partial |
| S-0674 | Semantic JE/GL search | Over lines + memos | [D2] R2R S1 M13 | spec ⭐NEW; R2R S1 #3 |
| S-0675 | Tenant-phrasing memory for JE composer | Style learning | [D2] R2R S1 M14 | partial |

## Fixed assets, leases & schedules

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 192 | Fixed Assets — Asset register with auto-depreciation | MD9 note: register wired; depth missing | Audit #192 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: 🔶/⬜; seq P3-MED |
| 193 | Fixed Assets — MACRS 3/5/7/10/15/20yr, SL, DDB methods | MACRS 3/5/7/10/15/20, SL, DDB (+ SYD per §04). MD9 note: register wired; depth missing | Audit #193 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: SCHEMA; MD9: 🔶/⬜; seq P3-MED |
| 194 | Fixed Assets — Monthly depreciation auto-JE to GL | MD9 note: register wired; depth missing | Audit #194 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: 🔶/⬜; seq P3-MED |
| 195 | Fixed Assets — Disposal with gain/loss calculation + JE | Disposal with gain/loss JE. MD9 note: register wired; depth missing | Audit #195 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: 🔶/⬜; seq P3-MED |
| 196 | Fixed Assets — Transfer between entities with intercompany JE | Transfer between entities with intercompany JE. MD9 note: register wired; depth missing | Audit #196 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: 🔶/⬜; seq P3-MED |
| 197 | Fixed Assets — Impairment recording | MD9 note: register wired; depth missing | Audit #197 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: 🔶/⬜; seq P3-MED |
| 198 | Fixed Assets — Depreciation schedule and forecast reports | MD9 note: register wired; depth missing | Audit #198 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: 🔶/⬜; seq P3-MED |
| 199 | Fixed Assets — Asset valuation reports (cost, NBV, accumulated dep) | MD9 note: register wired; depth missing | Audit #199 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: 🔶/⬜; seq P3-MED |
| 309 | Barcode/QR generation and label printing |  | Audit #309 (Cat 15); BuildSpec v4.3 §04 Fixed Assets (Physical); MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 310 | Mobile barcode scanning via camera (no hardware needed) |  | Audit #310 (Cat 15); BuildSpec v4.3 §04 Fixed Assets (Physical); MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 311 | Check-in / check-out tracking with history log |  | Audit #311 (Cat 15); BuildSpec v4.3 §04 Fixed Assets (Physical); MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 312 | Asset assignment to person / department / location |  | Audit #312 (Cat 15); BuildSpec v4.3 §04 Fixed Assets (Physical); MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 313 | Mobile audit with offline mode (sync on reconnect) |  | Audit #313 (Cat 15); BuildSpec v4.3 §04 Fixed Assets (Physical); MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 314 | GPS coordinates capture on scan |  | Audit #314 (Cat 15); BuildSpec v4.3 §04 Fixed Assets (Physical); MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 315 | Preventive maintenance scheduling with notifications |  | Audit #315 (Cat 15); BuildSpec v4.3 §04 Fixed Assets (Physical); MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 316 | Repair ticket creation and cost tracking |  | Audit #316 (Cat 15); BuildSpec v4.3 §04 Fixed Assets (Physical); MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 317 | Warranty and insurance tracking with expiration alerts |  | Audit #317 (Cat 15); BuildSpec v4.3 §04 Fixed Assets (Physical); MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 318 | Asset photos and document gallery |  | Audit #318 (Cat 15); BuildSpec v4.3 §04 Fixed Assets (Physical); MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 319 | Custom fields per asset type/category |  | Audit #319 (Cat 15); BuildSpec v4.3 §04 Fixed Assets (Physical); MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 320 | Inspection checklists (custom per asset type) |  | Audit #320 (Cat 15); BuildSpec v4.3 §04 Fixed Assets (Physical); MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 321 | Asset kitting / bundling |  | Audit #321 (Cat 15); BuildSpec v4.3 §04 Fixed Assets (Physical); MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 322 | Audit discrepancy reporting (expected vs found) |  | Audit #322 (Cat 15); BuildSpec v4.3 §04 Fixed Assets (Physical); MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 323 | Asset Panda bidirectional sync (v3.1 enhancement) |  | Audit #323 (Cat 15); BuildSpec v4.3 §04 Fixed Assets (Physical); MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 430 | Asset Panda bidirectional sync |  | Audit #430 (Cat 23); BuildSpec v4.3 §25; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| S-0676 | Asset/depreciation-expense/accumulated-depreciation accounts mapped per asset; monthly depreciation as recurring JEs; Sum-of-Years-Digits method also listed | SYD missing per §04 | BuildSpec v4.3 §04, §10 |  |
| S-0677 | Asset acquisition creates fixed-asset row + depreciation (+ optional tax track); prepaid purchase creates amortization schedule; deferred revenue creates recognition schedule | Provisioning services | MD9 GATE 2 | BUILT |
| S-0678 | Schedule engine: prepaid amortization, deferred revenue, straight-line schedules with idempotent run logs |  | MD9 GATE 2 (mig 031) | BUILT |
| S-0679 | Dual-book depreciation: GL carries book; parallel tax track (MACRS half-year 3–20 yr, SL, §179 with phase-out, bonus) never posted to GL; book-tax difference exposed for deferred tax; MID_QUARTER/MID_MONTH unsupported | Decision locked S21 | MD9 GATE 2, X.1 | BUILT |
| S-0680 | Asset disposal service: remove cost + accumulated depreciation, book gain/loss |  | MD9 GATE 2 | BUILT (service) |
| S-0681 | Contract-to-accounting (9c): ingest lease/loan/MSA/subscription → ASC 842 schedule, ASC 606 waterfall, debt amortization, recurring JE schedules citing clauses |  | MD9 GATE 9c | OPEN |
| S-0682 | Leases ASC 842: ROU asset + lease liability at inception; operating vs finance expense; schedules; AI classifies from signed lease (CPA-confirmed) |  | Posting Engine Spec B11 |  |
| S-0683 | Capitalization threshold per company (IRS de minimis $2,500 / $5,000 guidance), CPA-confirmed |  | Posting Engine Spec B6 |  |
| S-0684 | Fixed-asset lifecycle | Capitalize over threshold; depreciation; disposal gain/loss | [H] D20 | Canon |
| S-0685 | Dual-book tax depreciation | Never posted to the financial GL | [H] D40 Part VII GATE 2 (mig 033); [D1] CATv2 TX-D2 | Built; High 3.40; built |
| S-0686 | Depreciation methods + disposal by role + roll-forward | Declining balance / sum-of-years / units of production | [H] S43 §2; S44 (mig 079) | Built |
| S-0687 | Fixed-asset integrity | Reverse GL if subledger insert fails; disposal idempotent | [H] S50 §2 | Fixed |
| S-0688 | Leases (ASC 842) | Right-of-use asset / lease liability at commencement; operating vs finance expense | [H] D20; S50 §2 | Built (commencement now posts) |
| S-0689 | Schedule engine | Prepaid amortization, depreciation, deferred revenue, lease, loan amortization, rev-rec | [H] D20 GATE 2 | Built |
| S-0690 | Insurance amortization posts | Prepaid → straight-line expense | [H] S48 §2 (mig 132) | Built |
| S-0691 | Intangibles / prepaids / leases forms | Default to active company | [H] S48 §2 | Built |
| S-0692 | Cap-threshold and amortization defaults | — | [H] D40 Part X | Open decision |
| S-0693 | Contract-to-accounting (ASC 842 / 606) | GATE 9c | [H] D40 Part VII | OPEN |
| S-0694 | Replace Asset Panda | — | [H] D20 | Goal |
| S-0695 | Capex-vs-expense classifier | De-minimis safe harbor ($2,500 / $5,000) and repair-vs-improvement (RABI) test. B5 / AP-C3 / TX-D1. | [D1] CATv1 B5; CATv2 TX-D1; CPA B2 | High 3.30; partial; Top30 #23 |
| S-0696 | Auto-create the fixed-asset record on capitalization | Proposes life, method and §179/bonus eligibility; writes an M-1 tag | [D1] CATv1 B5; CPA B2 | — |
| S-0697 | §179 / bonus / de-minimis election presenter | Never auto-elects. TX-D3. | [D1] CATv2 TX-D3; CPA B2; [D2] TAX Group D; R2R S6 M11 | High 3.20; partial; PARTIAL; TAX #4 |
| S-0698 | Disposition and depreciation recapture (§1245/1250) | Stop depreciating sold assets. TX-D4. | [D1] CATv2 TX-D4; CPA A1 | Med 3.05; partial |
| S-0699 | Capex invoice → asset document extraction | NEW-FA1 | [D1] CATv2 §6.1 | none; Top30 #23 |
| S-0700 | Asset-class / useful-life / MACRS assignment | NEW-FA2 | [D1] CATv2 §6.1 | none |
| S-0701 | FA subledger → GL tie-out and physical tie-out | NEW-FA3 | [D1] CATv2 §6.1; [D2] R2R S6 M3 | none; spec ⭐NEW |
| S-0702 | Ghost-asset / missed-run / negative-NBV anomaly | NEW-FA4 | [D1] CATv2 §6.1 | none |
| S-0703 | Depreciation forecast with capex bridge | FA-native projection | [D1] CATv2 §6.1; [D2] R2R S6 M5; FPA C3 | none; spec ⭐NEW |
| S-0704 | Missed-run / fully-depreciated / warranty-lease-expiry alerts | NEW-FA6 | [D1] CATv2 §6.1; [D2] R2R S6 M12 | none; spec ⭐NEW |
| S-0705 | Depreciation run, disposals and FA roll-forward | Fixed assets are a thin segment | [D1] COV #17 | gap (Low discovery) |
| S-0706 | ASC 842 lease accounting | Listed as an area where MeritBooks is ahead | [D1] GAP §5 | built |
| S-0707 | Capex-vs-expense classifier + auto-create asset | Threshold prompt; de-minimis safe harbor ($2,500/$5,000); repair vs improvement (RABI) test; creates FA record with proposed life/method/§179/bonus; asset-class/MACRS-class assignment (AP C3, TAX D1) | [D2] AP Group C; TAX Group D; R2R S6 M2 | PARTIAL (not wired to bill entry); TAX #4 |
| S-0708 | Dual-book depreciation (book SL vs tax MACRS/§179/bonus) | Parallel non-posting tax schedule; MACRS 3/5/7/10/15/20-yr half-year tables; `tax_depreciation_runs` (TAX D2) | [D2] TAX Group D; GLC B4 | BUILT (mig 033/034); MID_QUARTER/MID_MONTH unsupported |
| S-0709 | Disposition & depreciation-recapture tracking | Stops depreciation; gain/loss; §1245/1250 recapture; "sold but still depreciating" detector (TAX D4) | [D2] TAX Group D | PARTIAL (book disposal built); TAX #4 |
| S-0710 | Capex-invoice → asset IDP | Description, in-service date, cost, qty | [D2] R2R S6 M1 | spec ⭐NEW; R2R S6 #1 |
| S-0711 | Ghost-asset / missed-run / negative-NBV / disposal-without-gain-loss detector | Detection | [D2] R2R S6 M4 | spec ⭐NEW; R2R S6 #3 |
| S-0712 | Depreciation / disposal / impairment entry drafting; non-SL book methods | Book is STRAIGHT_LINE-only today | [D2] R2R S6 M6 | partial (impairment + non-SL not built) |
| S-0713 | NBV / gain-loss narrative | Explanation | [D2] R2R S6 M7 | spec ⭐NEW |
| S-0714 | NL asset-register query | "Fully-depreciated vehicles at Heritage" | [D2] R2R S6 M8 | spec ⭐NEW |
| S-0715 | Monthly depreciation-run agent + auto-depreciate dial | Idempotent across assets; close wiring | [D2] R2R S6 M9/M10 | partial |
| S-0716 | Asset doc retrieval | Warranty, lease, insurance | [D2] R2R S6 M13 | spec ⭐NEW |
| S-0717 | Asset-class → life/method default memory | Learning | [D2] R2R S6 M14 | spec ⭐NEW |
| S-0718 | Prepaid amortization & straight-line schedule engine | `posting_schedule` + runs; missed runs → EC-2 signal C; schedule create/manage UI (GLC B2) | [D2] GLC Group B | PARTIAL (UI thin) |
| S-0719 | Depreciation & interest-accrual scheduler in close | Scheduled entries for depreciation and debt interest (GLC B4) | [D2] GLC Group B | PARTIAL |

## Debt, equity & covenants

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 208 | Debt Schedule — instrument, lender, balance, rate, maturity, payment | Instrument, lender, original, balance, rate, maturity, payment, type (P&I / IO / custom); term, SBA, LOC. MD9 note: debt_instruments | Audit #208 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 209 | Equity Schedule — holder, class, units, ownership %, contributions, distributions | Holder, class A/B, units, %, contributions, distributions YTD. MD9 note: equity_holders | Audit #209 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 431 | Borrowing base calculator (upload bank template, auto-fill from AR/inventory) | Upload bank template, auto-fill from AR/inventory, PDF certificate, limit alerts | Audit #431 (Cat 23); BuildSpec v4.3 §25; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| S-0720 | Debt schedule fields: instrument, lender, original amount, balance, rate, maturity, monthly payment, payment type (P&I, interest-only, custom); term loans, SBA loans, LOCs; liability + interest accounts mapped per instrument |  | BuildSpec v4.3 §10 |  |
| S-0721 | Borrowing base calculator: upload bank template, auto-fill from AR/inventory, generate PDF certificate; Claude flags approaching limits |  | BuildSpec v4.3 §25 #6 | v3.1 approved |
| S-0722 | Covenant meter UI (e.g. DSCR) with colored track, floor marker, needle turns red on breach |  | Platform Design Criteria §3 |  |
| S-0723 | Loan draw, loan payment with principal/interest split from amortization schedule (AI can build from loan document), accrued interest |  | Posting Engine Spec B7 |  |
| S-0724 | Owner/member contributions and owner draws/distributions | — | Posting Engine Spec B8; [H] D20 | ; Canon |
| S-0725 | Debt schedule report (balance, rate, maturity) — "essential"; debt & equity create/edit forms | Mike's feedback | Handoff S9 §4–5 | P2 (forms) |
| S-0726 | Loan templates | Draw; payment (principal + interest); accrued interest | [H] D20 | Canon |
| S-0727 | Debt origination posts | DR cash / CR notes payable (2500); payment splits principal and interest; returns 422 if no open period | [H] S50 §2 (mig 149) | Built |
| S-0728 | Covenant monitor | DSCR / FCCR / leverage headroom; projected breach date; AI-drafted compliance certificate | [H] S44 §2 (mig 078) | Built |
| S-0729 | Borrowing-base calculator | Eligible AR (past-due carve-out, concentration cap, cross-aging) × rate + eligible inventory with sublimit; certificate; PDF/XLSX | [H] S50 §2 | Built |
| S-0730 | Debt summary | — | [H] S49 | Built |
| S-0731 | PE / exit diligence | GATE 9d | [H] D40 Part VII | OPEN |
| S-0732 | Covenant continuous monitor with draft certificate | DSCR, FCCR, leverage / debt-to-EBITDA, current ratio, min liquidity, TNW. Computed daily on actuals + forecast. Green / amber / red with projected breach date. CFO signs; never auto-filed. E1 / FP-G2. | [D1] CATv1 E1; CATv2 FP-G2; CFO #5 | Crit 3.85; none (CATv2) vs built (GAP); Top30 #13 |
| S-0733 | Machine-readable covenant definitions per credit agreement | Formula, threshold, test frequency, cure period | [D1] CFO #5 | — |
| S-0734 | Covenant breach-date projection | NEW-FC1 | [D1] CATv2 §6.3 | none |
| S-0735 | Borrowing-base certificate and eligible-collateral forecast | FP-G3. Borrower-side white space. | [D1] CATv2 FP-G3; GAP §1, §5; [D2] BC Group F; FPA Group G; FTP §2 M6 | High 3.30; none (CATv2) / built (GAP); MISSING; deferred (ABL segment) |
| S-0736 | Covenant certificates and lender packs auto-sent on a schedule | Branded PDF / PPT / XLSX | [D1] GAP §3B #17 | T2; partial (no schedule) |
| S-0737 | Lender/investor package and data-tape generation | FP-G4 | [D1] CATv2 FP-G4 | High 3.20; none |
| S-0738 | Debt/financing schedule with interest forecast | Feeds covenant monitor. FP-C4. | [D1] CATv2 FP-C4; [D2] FPA Group C | High 3.40; none; none; leveraged segment |
| S-0739 | Value-creation / equity bridge and MOIC/IRR (PE) | FP-H2 | [D1] CATv2 FP-H2 | Med 3.00; none |
| S-0740 | Basis / capital-account / K-1 roll | TX-E6 | [D1] CATv2 TX-E6; CPA A1 | High 3.10; none |
| S-0741 | Covenant / liquidity continuous monitor | Machine-readable definitions (DSCR, FCCR, leverage / net-debt-to-EBITDA, current ratio, min liquidity, TNW); daily on actuals + forecast; green/amber/red; projected breach date; drafts compliance certificate (never auto-filed; bias conservative) (BC F1, FPA G2, GLC K2) | [D2] BC Group F; FPA Group G; GLC Group K; FTP §2 M5/M6/M12 | NOT BUILT; FPA #5 (GATE 7); BC Tier 4 #11; FTP Forecasting top-3 (a); Merit tenant needs now |
| S-0742 | Credit-agreement covenant-definition + prior-certificate retrieval | Retrieval | [D2] FTP §2 M13 | NONE ⭐NEW |

## Intercompany / inter-department / consolidation

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 17 | Intercompany auto-balancing JEs | Auto-balancing intercompany JEs; built as dept internal invoices + cross-entity due-to/due-from. MD9 note: built as inter-department internal invoice + elimination (II.4, IV.8); eliminating accounts 4990/5990/5991 | Audit #17 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ✅ |
| 66 | Bill-back invoicing (intercompany) — Chargeback engine | MD9 note: replaced by inter-department internal invoices, now BUILT incl. the DEPT_INVOICE_ISSUE Projects→Books seam (II.4, IV.8) | Audit #66 (Cat 3); BuildSpec v4.3 §04 AR, §21; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ⛔→✅; seq P1-HIGH |
| 203 | Intercompany Balances — Track between entities | MD9 note: tables exist | Audit #203 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 204 | Intercompany — 3-tier approval workflow (Manager → CFO → Owner) | Manager → CFO → Owner. MD9 note: tables exist | Audit #204 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 205 | Intercompany — AI document generation (Promissory Note, Borrower Resolution) | Claude drafts Promissory Note + Borrower Resolution. MD9 note: tables exist | Audit #205 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 206 | Intercompany — Built-in e-signature | Per-signer tracking, magic link, IP/user-agent capture, encrypted signature. MD9 note: tables exist | Audit #206 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 207 | Intercompany — Loan tracking with P&I payments, both sides posted | Principal & interest payments, both sides posted. MD9 note: tables exist | Audit #207 (Cat 8); BuildSpec v4.3 §10; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| S-0743 | Intercompany loan request workflow: 3-tier approval Manager → CFO → Owner; Claude drafts Promissory Note (terms, schedule, default provisions) and Borrower Resolution (references operating agreement) |  | BuildSpec v4.3 §10 |  |
| S-0744 | Built-in e-signature: per-signer tracking, magic-link access, IP/user-agent capture, encrypted signature data |  | BuildSpec v4.3 §10 |  |
| S-0745 | Internal charge method per company (Revenue default / Cost transfer) with per-department override; provider department's method governs | Plain-language helper text; "Help me choose" AI recommendation with one-line rationale | MD9 II.3, VIII.6 | BUILT |
| S-0746 | Inter-department internal invoice: provider/receiver dept, lines, optional job, memo, date; lifecycle draft→sent→approved→booked (+rejected, void); routes to receiving dept head for approval; books only on approval; rejection returns with reason | Replaces chargeback engine | MD9 II.4, VIII.6 | BUILT |
| S-0747 | Eliminating accounts 4990 Interdepartmental Services Revenue / 5990 Cost / 5991 Cost Transfer (is_eliminating); auto-created per company at setup |  | MD9 II.3, III.2, XI.4 | BUILT |
| S-0748 | Per-period internal-charge integrity check (provider internal revenue = receiver internal cost) with reconciliation badge |  | MD9 II.4 |  |
| S-0749 | Dual origination of internal invoices: direct-create in Books or DEPT_INVOICE_ISSUE event from Projects; identical booked effect |  | MD9 IV.8, VIII.6 | BUILT |
| S-0750 | Open: internal-invoice fields beyond basics (tax, attachments, recurring internal invoices) |  | MD9 X.1 | OPEN decision |
| S-0751 | Cross-entity intercompany: two linked balanced entries (one per entity), INTERCOMPANY_AR 1160 / AP 2020, consolidation eliminations; /intercompany page |  | MD9 XI.9 (mig 035) | BUILT, verified live |
| S-0752 | 11a Multi-entity consolidation (MANDATORY, top priority): parent/subsidiary tree, ownership %, entity-level eliminations, consolidated statements at any node of the org tree | Entity hierarchy parent_entity_id + ownership_pct built | MD9 GATE 11a | Top priority |
| S-0753 | Multi-entity GL with consolidation from day one; entity is canonical Core object |  | Suite Architecture §2.7 | Locked |
| S-0754 | Company → Department → Job model | Departments are user-defined, each with its own P&L / budget / FP&A | [H] D40 Part II | Canon |
| S-0755 | Inter-department internal invoices | Invoice-based, not hours-based; eliminating accounts 4990 / 5990 / 5991; provider's method governs | [H] D40 Part II, VIII; [D1] COV #9 | Built; partial |
| S-0756 | Intercompany due-to / due-from | Accounts 1160 / 2020 | [H] D40 Part III (mig 035) | Built |
| S-0757 | GATE 11a consolidation | Ownership %, non-controlling interest, eliminations | [H] S43 (mig 076); D40 Part VII | DEPTH built; was mandatory top priority |
| S-0758 | Eliminating accounts net to zero | With tie-out test | [H] S41 §2 | Built |
| S-0759 | FX translation (ASC 830) | Average / closing / historical rates; translation adjustment to equity | [H] S48 §2 (mig 133) | Built |
| S-0760 | EC-3 intercompany out-of-balance | — | [H] S41 | Built |
| S-0761 | Any client can be a consolidator | Owner directive; the roll-up view is a permission | [H] OD | Owner directive |
| S-0762 | Consolidation admin-gated | — | [H] S47 §2; S48 | Built |
| S-0763 | Management-company flag | Replaces the hardcoded "merit management" name match | [H] S47 (mig 111) | Built |
| S-0764 | Entity hierarchy | Parent entity + ownership % | [H] D20 | Built |
| S-0765 | Internal-invoice fields | — | [H] D40 Part X | Open decision |
| S-0766 | Intercompany matching, mirror-draft and imbalance block | Shared IC transaction ID; matched-pair register nets to zero; daily IC imbalance report; consolidation refuses to close with unmatched IC over threshold. GL-H1 / EC-3. | [D1] CATv2 GL-H1; CFO #2; CPA B5 | High 3.75; built (detect) |
| S-0767 | Consolidation depth | Ownership %, NCI, investment-in-sub elimination, arbitrary groupings, booked elimination ledger. GL-H2. | [D1] CATv2 GL-H2; COV #9; [D2] GLC Group H; R2R S7 M6/M9 | Crit 4.00; partial; Gate 11a MANDATORY; Top30 #4; PARTIAL (flat 100% roll-up); GLC #3 — GATE 11a MANDATORY, top priority |
| S-0768 | Multi-level consolidation trees | Funds → SPEs → portcos; elimination ledger with drill-down | [D1] GAP §3B #16 | T2; partial |
| S-0769 | Currency translation (CTA) | GL-H3 | [D1] CATv2 GL-H3; [D2] GLC Group H | Med 2.80; none; NOT BUILT; multi-currency segment |
| S-0770 | Investment-in-sub ↔ subsidiary-equity match | NEW-GL3 | [D1] CATv2 §6.1; [D2] R2R S7 M3 | none; ⭐NEW |
| S-0771 | Elimination-completeness detector | Detection | [D1] CATv2 §6.1; [D2] R2R S7 M4 | none; ⭐NEW |
| S-0772 | Pre-consolidation-readiness monitor | All entities closed + IC matched | [D1] CATv2 §6.1; [D2] R2R S7 M12 | none; partial ⭐NEW |
| S-0773 | Management-fee allocations and intercompany loans with interest | How Merit charges portfolio companies | [D1] GAP §3A #7 | T1 Now; missing (loans planned) |
| S-0774 | Intercompany cash pooling / netting view | Propose only; human release. BC-C5. | [D1] CATv2 BC-C5; [D2] BC Group C; R2R S7 M11 | High 3.20; none; MISSING; BC Tier 4 #10 |
| S-0775 | Consolidated-vs-sum-of-entities bridge narrative | M7 narrative | [D1] MATRIX §2; [D2] R2R S7 M7 | none; spec ⭐NEW; R2R S7 #3 |
| S-0776 | IC matching & balance control (EC-3) + mirror drafting | Due-to = due-from (1160/2020, `counterparty_location_id`); interdept + intercompany + one-sided invoice assertions; auto-mirror from a single side; daily imbalance report; consolidation blocked over threshold (GLC H1, TAX E1, BC F6) | [D2] GLC Group H; TAX Group E; BC Group F; R2R S7 M3/M4 | LIVE detect-only (mig 035); extensions pending |
| S-0777 | Intercompany posting natures | FUNDING / EXPENSE_ON_BEHALF / REPAYMENT; balanced on each entity's books | [D2] GLC 1.4 | LIVE (`intercompany.ts`) |
| S-0778 | Interdepartmental eliminations | `is_eliminating` internal-invoice Services Revenue/Cost net to zero; preserves real third-party cost | [D2] GLC 1.4 | LIVE (`eliminations.ts`) |
| S-0779 | Related-party flagging + ASC 850 disclosure schedule | Counterparty vs related-party/ownership graph; require mirror; AP auto-mirror on related-party bills; owner-benefit check (TAX E2, AP I2) | [D2] TAX Group E; AP Group I | PARTIAL; TAX #6 (consolidation FPB) |
| S-0780 | Subsidiary-TB / equity-investee statement IDP | Extraction | [D2] R2R S7 M1 | spec ⭐NEW |
| S-0781 | Entity → grouping + elimination-eligibility classification | Classification | [D2] R2R S7 M2 | partial ⭐NEW |
| S-0782 | Consolidated / NCI projection | Forecast | [D2] R2R S7 M5 | NONE |
| S-0783 | Elimination entry + consolidation memo drafting | Drafting | [D2] R2R S7 M6 | partial |
| S-0784 | NL "consolidate fund X for Q2" | Conversational | [D2] R2R S7 M8 | spec ⭐NEW |
| S-0785 | One-click consolidation-run agent + run dial | Aggregate → eliminate → NCI → translate → package | [D2] R2R S7 M9/M10 | partial |
| S-0786 | Ownership-structure Q&A + prior-elimination retrieval | Retrieval | [D2] R2R S7 M13 | spec ⭐NEW |
| S-0787 | Learn recurring eliminations | Auto-propose next period's eliminations | [D2] R2R S7 M14 | spec ⭐NEW |

## Tax / 1099 / sales tax / compliance

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 49 | 1099 contractor tracking ($600+ threshold, W-9, TIN masking) | $600+ aggregate across entities, W-9 status, TIN/EIN masking, YTD per vendor per entity. MD9 note: vendors.is_1099 | Audit #49 (Cat 2); BuildSpec v4.3 §04 AP; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶; seq P2-HIGH |
| 50 | 1099 form preparation and e-filing export | 1099 form prep + e-file export | Audit #50 (Cat 2); BuildSpec v4.3 §04 AP; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 147 | Regulatory Compliance Dashboard — entity × obligation grid | Obligations: Sales Tax, 940, State W/H, Monthly Financials, 941, State UI, Property Tax. MD9 note: compliance page wired | Audit #147 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶; seq P3-MED |
| 148 | Compliance: Filed This Month metric | MD9 note: demo only | Audit #148 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 149 | Compliance: Due Within 7 Days metric | MD9 note: demo only | Audit #149 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 150 | Compliance: Overdue with penalty exposure metric | MD9 note: demo only | Audit #150 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 151 | Compliance: Auto-Verified via GL data (22 of 34) | Auto-verified via GL data (computed expected vs filed). MD9 note: demo only | Audit #151 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 152 | Filing archive with on-time rate, auto-verified rate, total penalties YTD | YTD on-time rate, auto-verified rate, total penalties | Audit #152 (Cat 6); BuildSpec v4.3 §04 Close, §13; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P3-MED |
| 251 | 1099 Tracking page — vendors with $600+ payments, W-9 status, export |  | Audit #251 (Cat 11); BuildSpec v4.3 §14; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P5-LOWER |
| S-0788 | Compliance monitoring AI: compute expected tax amounts from revenue/payroll GL data, compare to filed amounts, flag discrepancies |  | BuildSpec v4.3 §07.8 |  |
| S-0789 | Compliance grid obligations: Sales Tax, Federal 940, State Withholding, Monthly Financials, Federal 941, State UI, Property Tax; cell status Filed/Auto-verified/Pending/In Progress/Overdue |  | BuildSpec v4.3 §13 |  |
| S-0790 | 1099 tracking: auto-flag vendors with $600+ aggregate across all entities; TIN/EIN masking; YTD per vendor per entity; export for e-filing |  | BuildSpec v4.3 §14 |  |
| S-0791 | Tax-year parameters (§179 cap/phase-out, bonus %) carried as system defaults; AI proposes new years; human confirms; per-asset override wins |  | MD9 GATE 2 (mig 034) | BUILT |
| S-0792 | Tax-provision readiness (9c): book-to-tax differences tracked, provision estimated, R&D credit and multi-state nexus flags (advisory) |  | MD9 GATE 9c | OPEN |
| S-0793 | 11d Sales-tax automation: multi-state nexus determination + rate lookup (Avalara/TaxJar-style) |  | MD9 GATE 11d | OPEN |
| S-0794 | Sales tax collected → Sales Tax Payable; remittance entry; income-tax provision accrual (advisory) |  | Posting Engine Spec B9 |  |
| S-0795 | Sales Tax page and 1099 Tracking page (mockups existed S7) |  | Handoff S7 page list |  |
| S-0796 | 1099-NEC readiness | Year-round; unincorporated, ≥$600, reportable rail (excludes card/1099-K); READY / MISSING_W9 / NOT_MARKED_1099; $ at risk; gaps first; queues W-9 chases (AP I1, TAX B3) | [H] S42 §2; [D2] TAX Group B; AP Group I | Built; BUILT (`/compliance-1099`) |
| S-0797 | NEC vs MISC box classification | — | [H] S49 §2 | Built |
| S-0798 | 1099-MISC + FIRE e-file | Copy B PDF + FIRE file | [H] S50 §2 | Built; transmission needs a TCC; IRIS not built |
| S-0799 | Sales tax posting | Credited at invoicing; remittance | [H] D20; S47 (mig 103–105) | Built |
| S-0800 | EC-7 economic-nexus tripwire | — | [H] S42 | Built |
| S-0801 | Sales-tax return prep | Worksheet + GL tie-out + nexus + filing calendar | [H] S44; S47 | Built |
| S-0802 | Live sales-tax rate engine | Effective-dated internal table; Avalara/TaxJar scaffold | [H] S50 (mig 144) | Built; vendor needs creds |
| S-0803 | Book-to-tax M-1/M-3 | At posting tags tax character: meals 50%, entertainment 0%, penalties 0%, federal tax, tax-exempt income, §179/bonus vs book depreciation, bad-debt reserve vs write-off, accruals, prepaids, §174; running M-1 bridge as a ledger dimension; Code-cited (TAX C1, AP C4) | [H] S44 (mig 077); [D2] TAX Group C; AP Group C; FTP §3 M2 | Built; NOT BUILT; TAX #1; "single richest AI opportunity" |
| S-0804 | ASC 740 tax provision | Current + deferred, rate reconciliation, valuation allowance, FIN 48. TX-C4. | [H] S45 (mig 091); S49; [D1] CATv2 TX-C4; CPA A2 | Built; High 3.20; none (GAP says built) |
| S-0805 | 1120-style Tax Return Package | Read-only, with PDF | [H] S45 §2 | Built |
| S-0806 | Tax depreciation page | — | [H] S47 §2 | Built (fixed) |
| S-0807 | Controls / SOX command center | — | [H] S45 §2 | Built |
| S-0808 | Sales-tax economic-nexus tripwire | Rolling 12-month revenue and transaction count by ship-to state, plus payroll and 3PL/FBA inventory locations, vs a per-state threshold table. Alerts at ~80% with projected breach date. Never auto-registers; human decides register / VDA. TX-A1 / F1 / EC-7. | [D1] CATv2 TX-A1; CATv1 F1; CPA A4/B3; [D2] TAX Group A; FTP §3 M4 | Crit 3.95; built; BUILT detect-only |
| S-0809 | Per-state nexus threshold-table UI and nexus-study artifact | — | [D1] COV #13; CPA B3 | gap |
| S-0810 | Income/franchise-tax nexus | Payroll, owned/leased property, inventory (3PL/FBA) by state (TAX A2) | [D1] CATv2 TX-A2; [D2] TAX Group A | High 3.40; none; Top30 #29; NOT BUILT; TAX #3 |
| S-0811 | Sales-tax registration and filing-status tracker | Needs a central table. TX-A3. | [D1] CATv2 TX-A3; [D2] TAX Group A | High 3.30; none; NEEDS CENTRAL; TAX #3 |
| S-0812 | Sales-tax rate and taxability at billing | Provider required (Avalara / TaxJar / Stripe Tax). TX-A4. | [D1] CATv2 TX-A4; INT §2.4 | High 3.30; none |
| S-0813 | Sales-tax liability accrual and return-prep worksheet | TX-A5 | [D1] CATv2 TX-A5; [D2] TAX Group A | High 3.25; none; NOT BUILT; TAX #7 |
| S-0814 | Use-tax accrual on untaxed purchases | TX-A6 | [D1] CATv2 TX-A6; CPA A4; [D2] TAX Group A | High 3.35; none; NOT BUILT; TAX #7 |
| S-0815 | Exemption-certificate management | Missing / expired. TX-A7. | [D1] CATv2 TX-A7; [D2] TAX Group A; FTP §3 M1 | High 3.20; none; NOT BUILT; TAX #7 |
| S-0816 | Marketplace-facilitator / 1099-K reconciliation | TX-A8 | [D1] CATv2 TX-A8; [D2] TAX Group A; FTP §3 M3 | Med 3.00; partial; PARTIAL (rail split built 1099-side) |
| S-0817 | 1099-NEC/MISC year-round readiness | Unincorporated payees ≥$600 by cash/check/ACH, excluding card/1099-K amounts; flags missing valid W-9; assembles the annual file. TX-B3 / F3. | [D1] CATv2 TX-B3; CATv1 F3; CPA A3/B4 | High 3.30; built |
| S-0818 | IRS TIN matching | Provider required. TX-B2. | [D1] CATv2 TX-B2; CPA A3; [D2] TAX Group B; AP Group B | High 3.35; partial (presence check only); PARTIAL (presence only); provider required; TAX #5; AP #8 |
| S-0819 | 1099 e-file (IRS FIRE/IRIS + state) and recipient delivery | Ingests accept/reject files. TX-B4. | [D1] CATv2 TX-B4; INT §2.4; [D2] TAX Group B; AP Group I | High 3.15; none (GAP says built); NOT BUILT; TAX #5; AP #8 |
| S-0820 | Backup-withholding trigger and 24% accrual | TX-B5 | [D1] CATv2 TX-B5; [D2] TAX Group B; FTP §3 M12 | Med 3.05; none; NOT BUILT; TAX #5 |
| S-0821 | Book-to-tax difference tagging (M-1/M-3) | At posting: meals 50%, entertainment 0%, penalties, federal tax, §179/bonus vs book depreciation, bad-debt reserve, prepaids, tax-exempt interest. Running M-1 bridge; each tag cites the Code section. TX-C1 / F2 / EC-9. Called "richest AI opportunity". | [D1] CATv2 TX-C1; CATv1 F2; CPA B1 | Crit 3.75; none; Top30 #5 |
| S-0822 | Temporary vs permanent classification (ASC 740 dimension) | TX-C2 | [D1] CATv2 TX-C2; [D2] TAX Group C | High 3.55; none; Top30 #5; NOT BUILT; TAX #1 |
| S-0823 | Deferred-tax (DTA/DTL) rollforward | Temp differences × enacted rate; valuation-allowance triggers (TAX C3) | [D1] CATv2 TX-C3; [D2] TAX Group C | High 3.30; none; NOT BUILT; TAX #8 |
| S-0824 | Estimated-payment scheduler with safe-harbor math (100/110%) | 100/110% prior year; quarterly reminders; human remits via EFTPS (TAX C5) | [D1] CATv2 TX-C5; CPA A1; [D2] TAX Group C | Med 3.05; none; NOT BUILT; TAX #8 |
| S-0825 | Multistate apportionment factors | TX-C6 | [D1] CATv2 TX-C6; [D2] TAX Group C | Med 3.00; none; NOT BUILT |
| S-0826 | PTET / composite election tracker | TX-C7 | [D1] CATv2 TX-C7; [D2] TAX Group C | Med 3.00; none; NOT BUILT |
| S-0827 | R&D §174 capitalization and §41 credit support | TX-C8 | [D1] CATv2 TX-C8; [D2] TAX Group C | Med 2.95; none; NOT BUILT |
| S-0828 | Other credits capture (WOTC, energy, state) | Eligibility signals (TAX C9) | [D1] CATv2 TX-C9; [D2] TAX Group C | Low 2.60; none; NOT BUILT |
| S-0829 | Tax-year statutory-parameter management | TX-D5 | [D1] CATv2 TX-D5; [D2] TAX Group D | Med 3.00; built; BUILT (mig 034) |
| S-0830 | Related-party graph and ASC 850 disclosure schedule | TX-E2 | [D1] CATv2 TX-E2; CPA B5 | High 3.30; partial |
| S-0831 | Owner-benefit / disguised-distribution classifier | TX-E3 | [D1] CATv2 TX-E3; CPA A1/B5; [D2] TAX Group E | High 3.25; none; NOT BUILT; TAX #6 |
| S-0832 | S-corp reasonable-compensation monitor | TX-E4 | [D1] CATv2 TX-E4; CPA A1; [D2] TAX Group E | Med 2.95; none; NOT BUILT |
| S-0833 | Transfer-pricing / §482 flag | TX-E5 | [D1] CATv2 TX-E5; [D2] TAX Group E | Low 2.60; none; NOT BUILT |
| S-0834 | Generic regulatory obligation / filing tracker | TX-G1 | [D1] CATv2 TX-G1; [D2] TAX Group G | Med 3.10; built; BUILT (`/compliance`) |
| S-0835 | Tax-calendar automation (federal / state / local due dates) | TX-G2 | [D1] CATv2 TX-G2 | High 3.25; partial |
| S-0836 | Entity / registered-agent / annual-report / franchise calendar | TX-G3 | [D1] CATv2 TX-G3; INT §2.4 | Med 3.00; none |
| S-0837 | Business-license / Secretary-of-State good-standing monitor | TX-G4 | [D1] CATv2 TX-G4; [D2] TAX Group G | Low 2.70; none; NOT BUILT |
| S-0838 | PBC / tie-out assurance pack | Standard PBC deliverables (TB, GL detail, agings, FA roll, debt/covenant schedules, rec packages, selected-JE support); continuous FS → TB → GL → source tie-out. TX-F3 = GL-G3 / B9. | [D1] CATv2 TX-F3; CPA A5/B9; [D2] TAX Group F; GLC Group G; AP Group I; FTP §3 M6 | Crit 3.55; none; Top30 #21; NOT BUILT; TAX #2 (new FPB) |
| S-0839 | PBC request automation (self-fulfilling audit list) | GL-G4 | [D1] CATv2 GL-G4 | High 3.35; none |
| S-0840 | Manual-JE population handed to auditors pre-scored with support attached | — | [D1] CPA B7 | — |
| S-0841 | Segment tax overlays | §263A UNICAP, LCM, obsolescence; cost segregation, §1031, passive activity, 704(b)/(c); nonprofit functional expense, restricted funds, single audit | [D1] CPA Part C | segment config |
| S-0842 | Never-the-regulated-party rule | MeritBooks never signs, registers, remits or e-files as agent; licensed provider does the regulated act; AI never files/registers/remits/elects | [D2] TAX intro, 1.10; FTP §3 M10 | Binding constraint |
| S-0843 | Rate & taxability determination | Per line: product/service × state taxability; state + county + city + district rate at ship-to; SKU tax-code mapping once (TAX A4) | [D2] TAX Group A; FTP §3 M13/M14 | NOT BUILT; TAX #7 (GATE 11d); provider required |
| S-0844 | Income-tax provision | Current + deferred; effective-rate reconciliation; FIN 48 uncertain positions; rate-rec narrative (TAX C4) | [D2] TAX Group C; FTP §3 M7 | NOT BUILT; TAX #8 |
| S-0845 | Basis / capital-account / K-1 roll | S-corp stock/debt basis; partnership tax-basis capital; roll to K-1s (TAX E6) | [D2] TAX Group E | NOT BUILT |
| S-0846 | Tax-calendar automation | Federal/state/local due dates; sales-tax cadence; Jan 31 1099; estimates; franchise; escalating reminders (TAX G2) | [D2] TAX Group G; FTP §3 M12 | PARTIAL |
| S-0847 | Entity good-standing calendar | Annual report, registered agent, franchise/minimum tax (e.g. CA $800, DE), foreign qualification, business licenses (TAX G3) | [D2] TAX Group G | NOT BUILT; provider (CSC/CT/Harbor) |
| S-0848 | NL tax Q&A | "Do we have nexus in TX?"; "1099 exposure?" | [D2] FTP §3 M8 | → nl-copilot |
| S-0849 | Provision-run & 1099-season orchestration | M-1 → temp/perm → DTA/DTL → rate rec → workpaper pack; readiness → TIN match → e-file handoff | [D2] FTP §3 M9 | partial |

## Reporting (every named report)

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 28 | Income Statement calculation (Revenue − COGS = Gross Profit − OpEx = Operating Income ± Other = Net Income) | MD9 note: v_income_statement; wired via API | Audit #28 (Cat 1); BuildSpec v4.3 §04 GL, §05; MD9 Part V | Apr-26 audit: SCHEMA; MD9: 🔶 |
| 67 | AR aging reports (summary/detail, by entity) | Current/30/60/90/120+; by customer/company/entity; drill to invoice. MD9 note: ar-aging-report renderer; v_ar_aging | Audit #67 (Cat 3); BuildSpec v4.3 §04 AR, §21; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ✅; seq P1-HIGH |
| 68 | Customer balance reports (summary/detail) | MD9 note: customer-balances API | Audit #68 (Cat 3); BuildSpec v4.3 §04 AR, §21; MD9 Part V | Apr-26 audit: MISSING; MD9: 🔶; seq P1-HIGH |
| 69 | Open invoices report | MD9 note: open-items API | Audit #69 (Cat 3); BuildSpec v4.3 §04 AR, §21; MD9 Part V | Apr-26 audit: MISSING; MD9: 🔶; seq P1-HIGH |
| 70 | Revenue by customer report | MD9 note: income-by-customer API | Audit #70 (Cat 3); BuildSpec v4.3 §04 AR, §21; MD9 Part V | Apr-26 audit: MISSING; MD9: 🔶; seq P1-HIGH |
| 71 | Unbilled charges / unbilled time reports |  | Audit #71 (Cat 3); BuildSpec v4.3 §04 AR, §21; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P1-HIGH |
| 86 | P&L (standard) with date range, company, department filters | Date range, company, department filters; drill to transaction. MD9 note: income-statement API wired | Audit #86 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅; seq P0-BLOCKER |
| 87 | P&L by month | MD9 note: pnl-by-month renderer | Audit #87 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: ✅; seq P0-BLOCKER |
| 88 | P&L by customer |  | Audit #88 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P0-BLOCKER |
| 89 | P&L by class |  | Audit #89 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P0-BLOCKER |
| 90 | P&L by department (departmental P&L) | MD9 note: department-aware income-statement + consolidated report built; drill-down depth pending | Audit #90 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: 🔶; seq P0-BLOCKER |
| 91 | P&L comparison (period vs period, YoY) | Period vs period, YoY, budget vs actual | Audit #91 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P0-BLOCKER |
| 92 | P&L detail | Drill-through to transactions | Audit #92 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: 🔶; seq P0-BLOCKER |
| 93 | P&L as % of total income |  | Audit #93 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P0-BLOCKER |
| 94 | Balance Sheet (standard) with as-of date, company filter | MD9 note: balance-sheet API wired | Audit #94 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅; seq P0-BLOCKER |
| 95 | Balance Sheet comparison (period vs period) |  | Audit #95 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P0-BLOCKER |
| 96 | Balance Sheet detail | Spec: Entity and consolidated | Audit #96 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V; [D1] COV #10; CFO wk2 | Apr-26 audit: MISSING; MD9: ❌; seq P0-BLOCKER; built |
| 97 | Balance Sheet summary |  | Audit #97 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P0-BLOCKER |
| 98 | Statement of Cash Flows (direct method) | MD9 note: cash-flow API | Audit #98 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: 🔶; seq P0-BLOCKER |
| 99 | Statement of Cash Flows (indirect method) |  | Audit #99 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P0-BLOCKER |
| 100 | Statement of Changes in Equity | MD9 note: equity-changes API. Spec: — | Audit #100 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V; [D1] COV #10 | Apr-26 audit: MISSING; MD9: 🔶; seq P0-BLOCKER; built |
| 101 | Trial Balance (adjusted vs unadjusted, by period, by entity) | Adjusted vs unadjusted, by period, by entity, include-zero toggle. MD9 note: gl/trial-balance API wired | Audit #101 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅; seq P0-BLOCKER |
| 102 | General Ledger detail (by account, date range, with source doc links) | By account, date range, with source document links. MD9 note: v_gl_detail + gl-detail API | Audit #102 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: SCHEMA; MD9: 🔶; seq P0-BLOCKER |
| 103 | Transaction detail by account |  | Audit #103 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P0-BLOCKER |
| 104 | Transaction list by date / by customer / by vendor | MD9 note: transaction-list API | Audit #104 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: 🔶; seq P0-BLOCKER |
| 105 | Consolidated statements across entities with eliminations | Select entities; eliminations; minority interest. MD9 note: /api/reports/consolidated + is_eliminating exclusion built; full depth pending | Audit #105 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: 🔶; seq P0-BLOCKER |
| 106 | Project profitability summary | MD9 note: job-profitability renderer; v_job_profitability | Audit #106 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ✅; seq P0-BLOCKER |
| 107 | AP aging summary and detail | MD9 note: ap-aging renderer; v_ap_aging | Audit #107 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ✅; seq P0-BLOCKER |
| 108 | AR aging summary and detail | MD9 note: ar-aging renderer; v_ar_aging | Audit #108 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ✅; seq P0-BLOCKER |
| 109 | Vendor balance summary/detail and vendor activity | MD9 note: vendor-balances API | Audit #109 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: 🔶; seq P0-BLOCKER |
| 110 | Customer balance summary/detail and customer activity | MD9 note: customer-balances API | Audit #110 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: 🔶; seq P0-BLOCKER |
| 111 | Open invoices / unpaid bills | MD9 note: open-items API | Audit #111 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: 🔶; seq P0-BLOCKER |
| 112 | Reconciliation reports |  | Audit #112 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P0-BLOCKER |
| 113 | Budget vs actual with variance ($ and %) | $ and % variance, color-coded. MD9 note: budgets table exists | Audit #113 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P0-BLOCKER |
| 114 | Custom Report Writer (drag-and-drop, saved views, scheduling) | Drag-and-drop custom report writer, saved views, scheduling | Audit #114 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P0-BLOCKER |
| 115 | Interactive drill-down from summary to transaction |  | Audit #115 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: 🔶; seq P0-BLOCKER |
| 117 | Board / investor reporting packages with AI narrative | Template-based, auto-populated, AI narrative | Audit #117 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P0-BLOCKER |
| 118 | Report export (PDF, Excel, CSV) | PDF, Excel, CSV. MD9 note: buttons exist, no logic. Spec: For humans | Audit #118 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V; Handoff S9 §4; [D1] INT §2.8 | Apr-26 audit: MISSING; MD9: ❌; seq P0-BLOCKER; P2; built |
| 119 | Scheduled report delivery (email) | Scheduled email delivery. Spec: — | Audit #119 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V; [H] S47 (mig 104); S48 | Apr-26 audit: MISSING; MD9: ❌; seq P0-BLOCKER; Built |
| 120 | AI-generated report commentary (variance explanations) | AI variance explanations, trends, anomalies, plain English | Audit #120 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P0-BLOCKER |
| 287 | Board/investor reporting packages with AI narrative |  | Audit #287 (Cat 13); BuildSpec v4.3 §04, §23; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 288 | Report export and scheduled delivery |  | Audit #288 (Cat 13); BuildSpec v4.3 §04, §23; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| S-0850 | P&L requirements: date range, company, department filters, comparative periods (MoM, YoY), drill-down to transaction |  | BuildSpec v4.3 §20 | BLOCKER |
| S-0851 | Balance Sheet requirements: as-of date, company filter, comparative periods, drill-down |  | BuildSpec v4.3 §20 | BLOCKER |
| S-0852 | Cash Flow Statement: operating/investing/financing; direct or indirect; date range; company filter |  | BuildSpec v4.3 §20 | BLOCKER |
| S-0853 | Trial Balance: period + company filters, include-zero-balance toggle, adjusted vs unadjusted |  | BuildSpec v4.3 §20 | BLOCKER |
| S-0854 | GL Detail: account filter, date range, source-document links |  | BuildSpec v4.3 §20 | BLOCKER |
| S-0855 | Consolidated statements: select entities, eliminations via is_intercompany flag, minority interest |  | BuildSpec v4.3 §20 | BLOCKER |
| S-0856 | Departmental P&L: company + department filters, comparative periods |  | BuildSpec v4.3 §20 | BLOCKER |
| S-0857 | Budget vs Actual: color-coded favorable/unfavorable, $ and % variance |  | BuildSpec v4.3 §20 |  |
| S-0858 | Custom Report Builder: account selection, dimension filters, date ranges, saved views, scheduling, PDF/Excel/CSV export |  | BuildSpec v4.3 §20 |  |
| S-0859 | Board/Investor package: template-based, auto-populated from GL, AI narrative |  | BuildSpec v4.3 §20 |  |
| S-0860 | AI report insights: variance explanations, trend analysis, anomaly detection, plain-English summaries |  | BuildSpec v4.3 §20 |  |
| S-0861 | Report consolidation toggle: department/management view includes internal lines (service depts read as profit centers); company/consolidated view nets eliminating accounts to zero | "No-inflation / no-deflation guarantee" | MD9 II.4 | BUILT |
| S-0862 | Cash basis offered as a reporting-layer option over the accrual book (not a dual ledger) |  | MD9 X.1, IV.2 | Decision locked |
| S-0863 | GATE 7: department drill-down on all statements, comparatives, drill-through, export PDF/Excel/CSV, budgets drive variance at dept/company/org |  | MD9 GATE 7 | OPEN |
| S-0864 | One-click PE/exit diligence package (9d): normalized EBITDA bridge, customer concentration, working-capital trends, every number source-linked |  | MD9 GATE 9d | OPEN |
| S-0865 | Consolidation shows eliminations and NCI (non-controlling interest) natively; intercompany lines visibly net to zero |  | Platform Design Criteria §4 |  |
| S-0866 | Dimensional reporting depth: report/budget across any dimension combination on the fly |  | Posting Engine Spec Part I #11 | BUILD (GATE 7) |
| S-0867 | Natural-language report queries, report export service, saved reports | Services nl-reports, report-export, saved-reports existed S7 | Handoff S7 §1 |  |
| S-0868 | Balance sheet A = L + E check shown |  | Handoff S8 §1 | BUILT S8 |
| S-0869 | Report Center: left category menu (Financial Statements, AR, AP, Jobs, Management, Tax) + report cards with capability badges (Cash/Accrual, Summary/Detail, Comparative) |  | Handoff S9 §2, §5 | BUILT S9 |
| S-0870 | Multi-select company filter grouped by industry; industry filter auto-selects matching companies; every report API must accept multiple companies and aggregate | Mike's explicit feedback | Handoff S9 §2, §5 |  |
| S-0871 | Period presets: This Month, Last Month, This Quarter, Last Quarter, YTD, YTD Through Last Month (closed periods only), Last Year, Last 12 Months, Custom | Mike: presets not manual dates | Handoff S9 §2, §5 | BUILT S9 |
| S-0872 | Cash vs accrual toggle that actually changes numbers (cash basis must filter to cash-moved entries) | Mike: toggle must not be cosmetic | Handoff S9 §2, §4, §7 | P1 |
| S-0873 | Every report offers Summary AND Detail views | Mike's feedback | Handoff S9 §5 |  |
| S-0874 | Equity: current equity holders table (not just statement of changes) | Mike's feedback | Handoff S9 §5 |  |
| S-0875 | Expense by Vendor and Income by Customer reports (summary + detail); Sales by Customer (invoice lines); Transaction List by date with by-day summary; Open Items (open AR + AP combined); Vendor Balances; Customer Balances; Debt Schedule; Equity Table; Consolidated P&L with IC elimination | Mike pushed: "what about expense by vendor, income by customer" | Handoff S9 §1, §7 | BUILT S9 (generic renderer) |
| S-0876 | Purpose-built renderer for every report (no generic auto-table) |  | Handoff S9 §7 |  |
| S-0877 | GL drill-down: click any account row → GL transactions |  | Handoff S9 §1 | BUILT S9 |
| S-0878 | Natural-language report query bar ("Show me revenue by customer for Q1" → report + filters) |  | Handoff S9 §4 | P2 |
| S-0879 | Department multi-select filter on reports |  | Handoff S9 §4 | P1 |
| S-0880 | Industry benchmarks on reports (external benchmark data) | Mike wants industry comparison | Handoff S9 §4 | P3 |
| S-0881 | AP/AR aging renderer: stacked aging bar, grouping with subtotals, buckets Current/1–30/31–60/61–90/90+, overdue highlighting |  | Handoff S10 §1, §5 | BUILT S10 |
| S-0882 | Job profitability renderer: margin bars (green >20%, amber 10–20%, red <10%), % complete, over/under billed |  | Handoff S10 §1 | BUILT S10 |
| S-0883 | Expense by Vendor renderer: ranked spend, cumulative %, top-5 concentration, distribution bars |  | Handoff S10 §1 | BUILT S10 |
| S-0884 | P&L by Month 12-column grid with sticky first column, gross profit and net income rows |  | Handoff S10 §1 | BUILT S10 |
| S-0885 | Core statements | P&L / BS / CF / TB / GL detail / aging / job profitability | [H] D40 Part III; S41 | Built |
| S-0886 | Period selector + comparatives | Prior period / prior year / budget | [H] S42 §2 | Built |
| S-0887 | Department filter + consolidation toggle | — | [H] D40 Part VI | Required |
| S-0888 | Exports | PDF + CSV, then real XLSX + multi-sheet packs | [H] S42 §2; S48 §2 | Built |
| S-0889 | Saved report views + drill + exec summary | — | [H] S49 (mig 138) | Built |
| S-0890 | Board package | MD&A + KPI trend strip + DSO/DPO | [H] S44; S49 | Built; history needs aging snapshots |
| S-0891 | M7 flux / variance narrative | Model only phrases the numbers | [H] S43 §2; [D1] CATv2 FP-D2; CATv1 E3; MGR A2; [D2] GLC Group E; FPA Group D; R2R S4 M7; FTP §1 M7 | Built; Crit 3.95; none; Top30 #6; NOT BUILT; FPA #2; GLC #4; "marquee BEAT-QBO" |
| S-0892 | Explain-this-X drawer | — | [H] S46 §5 | In flight |
| S-0893 | Direct-method cash flow | — | [H] S45 | Built |
| S-0894 | Per-entity profitability | — | [H] S42 | Built |
| S-0895 | Inventory valuation report | — | [H] S49 | Built |
| S-0896 | Reporting-basis overlay | Accrual / Tax / Cash / Custom; never posts; one-click cash | [H] S50 (mig 147) | Built |
| S-0897 | Full multi-book ledger | — | [H] S50 §4 | Deferred |
| S-0898 | GATE 7 reporting / FP&A depth | Financial-reports FPB written | [H] D40 Part VII; S41 | OPEN |
| S-0899 | Profit & loss | Entity and consolidated; budget vs actual; variance commentary | [D1] COV #10; CFO wk2 | built |
| S-0900 | Cash flow statement | BC-F11 | [D1] COV #10; CATv2 §2.5 note | built |
| S-0901 | AP aging report | — | [D1] COV #10; GAP §2 | built |
| S-0902 | AR aging report and DSO | — | [D1] COV #5/#10 | built |
| S-0903 | WIP report | — | [D1] COV #10/#16 | built |
| S-0904 | Job-cost report | — | [D1] COV #16 | built |
| S-0905 | Job-profitability report | — | [D1] COV #16 | built |
| S-0906 | Consolidated report | `reports/consolidated` | [D1] COV #9 | partial |
| S-0907 | Trial balance | — | [D1] CPA A1/B9 | built (implied) |
| S-0908 | Budget-vs-actual (versioned, dimensional, drill-through) | FP-D1 | [D1] CATv2 FP-D1; COV #11 | High 3.70; partial |
| S-0909 | Board / management package auto-generation | KPI dashboard, entity roll-ups, cash and liquidity, variance narrative, forward look (13-week). FP-G1. | [D1] CATv2 FP-G1; CFO wk2; [D2] FPA Group G; R2R S4 M9 | Crit 3.90; none; Top30 #13; none; FPA #5 |
| S-0910 | External / prior-auditor financials document extraction | NEW-RP1 | [D1] CATv2 §6.1 | none |
| S-0911 | COA → financial-statement line mapping | NEW-RP2 | [D1] CATv2 §6.1 | none; Top30 #26 |
| S-0912 | Cross-report and report → GL tie-out | NEW-RP3 | [D1] CATv2 §6.1; [D2] R2R S4 M3 | none; spec ⭐NEW |
| S-0913 | Statement-integrity checks | NEW-RP4 | [D1] CATv2 §6.1; [D2] R2R S4 M4 | none; spec ⭐NEW |
| S-0914 | Footnote / MD&A / disclosure drafting | NEW-RP5 | [D1] CATv2 §6.1; [D2] R2R S4 M6 | none; spec ⭐NEW |
| S-0915 | Insight surfacing / which-KPI-to-review | NEW-RP6 | [D1] CATv2 §6.1; [D2] R2R S4 M11 | none; spec ⭐NEW |
| S-0916 | Report-freshness / KPI-breach alerts | NEW-RP7 | [D1] CATv2 §6.1; [D2] R2R S4 M12 | none; spec ⭐NEW |
| S-0917 | Drill-through narrative layer on reports | — | [D1] COV #10 | gap |
| S-0918 | Deferred-revenue and unbilled / contract-asset roll-forwards | — | [D1] CFO #8 | — |
| S-0919 | Core financial statements & report routes | ~20 routes (income statement, balance sheet, cash flow indirect, agings, GL detail, AP aging, expense-by-vendor, equity changes, job-cost ledger, `v_job_profitability`); RLS-scoped | [D2] R2R S4; BC F11; AP H2/I4; FTP §6; GLC G2 | BUILT |
| S-0920 | Consolidated + entity P&L / BS / CF | With BvA + variance narrative | [D2] GLC 1.1; FPA 1.3 | Flat roll-up built |
| S-0921 | Lender / investor package & data tape | Credit-agreement/LPA cadence; human sign-off (FPA G4) | [D2] FPA Group G; FTP §1 M6 | none |
| S-0922 | Benchmark vs peers / industry | Gross margin, OPEX %, DSO/DPO, comp/revenue vs external dataset (FPA G5) | [D2] FPA Group G | none |
| S-0923 | Spend analytics & vendor concentration | By vendor/category/dept/job/period; off-contract spend, price drift, savings (AP I4) | [D2] AP Group I | PARTIAL |
| S-0924 | NL report / query builder | Plain English → real report config, never fabricated (FPA K1) | [D2] FPA Group K; R2R S4 M8 | NONE (decorative box); R2R S4 #2 |
| S-0925 | External-financials / prior-auditor IDP | Beginning balances/comparatives from PDFs | [D2] R2R S4 M1 | spec ⭐NEW |
| S-0926 | COA → statement-line / disclosure-grouping mapping | XBRL-adjacent | [D2] R2R S4 M2 | partial ⭐NEW |
| S-0927 | Trend projection on report lines | Projection | [D2] R2R S4 M5 | partial |
| S-0928 | Report-publish approval gate | SoD before external share | [D2] R2R S4 M10 | partial |
| S-0929 | Semantic report search + accounting-policy / GAAP Q&A | Grounded in docs | [D2] R2R S4 M13 | spec ⭐NEW; R2R S4 #3 |
| S-0930 | Learn report layout / KPI / narrative-tone preferences | Learning | [D2] R2R S4 M14 | spec ⭐NEW |

## FP&A, budgets, cash forecasting

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 83 | Cash position reporting (real-time across all entities) | MD9 note: cash page wired; v_cash_position | Audit #83 (Cat 4); BuildSpec v4.3 §04 Banking, §06; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅; seq P1-HIGH |
| 210 | Daily Cash Report — per-company cash positions from bank feeds | MD9 note: cash page wired | Audit #210 (Cat 9); BuildSpec v4.3 §11; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶 |
| 211 | Daily Cash — minimum cash target alerts | Min-cash target per company; Healthy / Near Minimum | Audit #211 (Cat 9); BuildSpec v4.3 §11; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 212 | Daily Cash — AI proactive insights (transfer recommendations) | E.g. recommend intercompany transfer before payroll | Audit #212 (Cat 9); BuildSpec v4.3 §11; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 213 | 13-Week Cashflow — rolling forecast (13 weekly columns) | MD9 note: forecast page wired | Audit #213 (Cat 9); BuildSpec v4.3 §11; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶 |
| 214 | 13-Week Cashflow — synthesizes bank feeds + AP/AR aging + payroll + recurring + historical | Bank feeds + AP/AR aging + payroll + recurring + 3 yrs history | Audit #214 (Cat 9); BuildSpec v4.3 §11; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 215 | 13-Week Cashflow — 4 AI intelligence categories (risk, AR patterns, seasonal, confidence) | Risk alerts, AR payment patterns, seasonal adjustments, confidence | Audit #215 (Cat 9); BuildSpec v4.3 §11; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 216 | 13-Week Cashflow — confidence degradation (92%/78%/64%) | 92% wks 1–2 / 78% wks 3–6 / 64% wks 7–13 | Audit #216 (Cat 9); BuildSpec v4.3 §11; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 217 | Scenario Modeling — toggleable what-if scenarios | Toggle: delay purchase, customer pays late, add hire, win project | Audit #217 (Cat 9); BuildSpec v4.3 §11; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 218 | Scenario Modeling — NL scenario queries via Claude (v3.1 enhancement) |  | Audit #218 (Cat 9); BuildSpec v4.3 §11; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 219 | Scenario Modeling — chainable scenarios |  | Audit #219 (Cat 9); BuildSpec v4.3 §11; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 220 | Self-correcting accuracy — Forecast vs Actual with AI explanations | 4-week rolling forecast vs actual with AI explanations | Audit #220 (Cat 9); BuildSpec v4.3 §11; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 266 | Annual budget creation by account, department, entity, period | By account, department, entity, period. MD9 note: budgets table | Audit #266 (Cat 13); BuildSpec v4.3 §04, §23; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 267 | Top-down budgeting (set total, allocate across departments) |  | Audit #267 (Cat 13); BuildSpec v4.3 §04, §23; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 268 | Bottom-up budgeting (departments submit, roll up) |  | Audit #268 (Cat 13); BuildSpec v4.3 §04, §23; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 269 | Import prior year actuals as starting point | Import prior-year actuals as starting point | Audit #269 (Cat 13); BuildSpec v4.3 §04, §23; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 270 | Industry-specific budget templates |  | Audit #270 (Cat 13); BuildSpec v4.3 §04, §23; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 271 | Collaborative budget workflow (assign to dept heads) | Assign to department heads | Audit #271 (Cat 13); BuildSpec v4.3 §04, §23; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 272 | Budget version control and audit trail |  | Audit #272 (Cat 13); BuildSpec v4.3 §04, §23; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 273 | Rolling forecasts with auto-update from actuals |  | Audit #273 (Cat 13); BuildSpec v4.3 §04, §23; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 274 | AI-assisted autoforecast (historicals + seasonality) | MD9 note: 13-week logic | Audit #274 (Cat 13); BuildSpec v4.3 §04, §23; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶; seq P2-HIGH |
| 275 | Driver-based forecasting (revenue/cost drivers) |  | Audit #275 (Cat 13); BuildSpec v4.3 §04, §23; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 276 | 3-statement pro forma modeling (P&L, BS, CF simultaneously) | P&L, BS, CF simultaneously | Audit #276 (Cat 13); BuildSpec v4.3 §04, §23; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 277 | Cash flow forecasting with working capital assumptions | MD9 note: 13-week | Audit #277 (Cat 13); BuildSpec v4.3 §04, §23; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶; seq P2-HIGH |
| 278 | Forecast roll-forward (update with latest actuals in clicks) |  | Audit #278 (Cat 13); BuildSpec v4.3 §04, §23; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 279 | Confidence bands on forecasts |  | Audit #279 (Cat 13); BuildSpec v4.3 §04, §23; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 280 | Scenario planning: create multiple what-if scenarios |  | Audit #280 (Cat 13); BuildSpec v4.3 §04, §23; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 281 | Scenario comparison side-by-side across 3 statements | Side-by-side across 3 statements | Audit #281 (Cat 13); BuildSpec v4.3 §04, §23; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 282 | NL scenario queries via AI (v3.1) |  | Audit #282 (Cat 13); BuildSpec v4.3 §04, §23; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 283 | Workforce planning (new hires, raises, bonuses, benefits impact) | New hires, raises, bonuses, benefits | Audit #283 (Cat 13); BuildSpec v4.3 §04, §23; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 284 | Headcount planning with burden rate impact modeling |  | Audit #284 (Cat 13); BuildSpec v4.3 §04, §23; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 428 | NL scenario modeling for 13-week forecast (chainable) |  | Audit #428 (Cat 23); BuildSpec v4.3 §25; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| S-0931 | Daily Cash Report fields: account (last 4), opening balance, inflows, outflows, closing balance, minimum cash target, status Healthy/Near Minimum; near-minimum highlighted |  | BuildSpec v4.3 §11 |  |
| S-0932 | Daily cash AI insights, e.g. recommend intercompany transfer or delaying a vendor payment ahead of payroll; AR aging trend narratives |  | BuildSpec v4.3 §11 |  |
| S-0933 | 13-week forecast rows: opening balance, inflows (customer payments, construction draws, other), total inflows, outflows (payroll, AP materials, rent, loans, insurance), total outflows, net, closing; negative weeks highlighted | Uses 3 years of history | BuildSpec v4.3 §11 |  |
| S-0934 | AR payment-pattern detection per customer (e.g. "Smith pays within 5 days; Williams averages 12 days late") feeding forecast |  | BuildSpec v4.3 §11 |  |
| S-0935 | Seasonal adjustment from 3-year analysis (e.g. 22% materials uplift Mar–Apr) |  | BuildSpec v4.3 §11 |  |
| S-0936 | Scenario toggles recalc full 13-week forecast in real time (delay purchase, customer pays late, add hire, win project) |  | BuildSpec v4.3 §11 |  |
| S-0937 | Forecast vs actual 4-week rolling accuracy with AI explanation of misses and widening confidence bands | Target 95%+ | BuildSpec v4.3 §11, §28 |  |
| S-0938 | Rolling forecasts blending budget with actual trends (AI-assisted) |  | BuildSpec v4.3 §23 | HIGH |
| S-0939 | KPI dashboards by role: CFO multi-entity metrics, managers entity-level; drill KPI → GL |  | BuildSpec v4.3 §23 | HIGH |
| S-0940 | Revenue forecasting: customer payment patterns, seasonality, pipeline-weighted projections |  | BuildSpec v4.3 §23 |  |
| S-0941 | Consolidated budget across selected entities with intercompany elimination |  | BuildSpec v4.3 §23 |  |
| S-0942 | Departmental budgets within each entity rolling up to entity and group |  | BuildSpec v4.3 §23 |  |
| S-0943 | Headcount planning: staffing cost modeling, impact of hires on capacity |  | BuildSpec v4.3 §23 |  |
| S-0944 | Budgets by (company, account, department, fiscal year, period 1–13) with budget versions; upsert entry |  | Handoff S9 §2 (mig 013) | BUILT S9 |
| S-0945 | Budget vs actual variance convention: revenue actual>budget favorable; expense actual<budget favorable; $ and % variance |  | Handoff S9 §3 | BUILT S9 |
| S-0946 | Cash position page per entity expandable with minimum cash targets |  | Handoff S10 §1 | BUILT S10 |
| S-0947 | Native FP&A pillar | Replaces Jirav | [H] ANCHOR §1; D20 | Canon |
| S-0948 | Budgets + budget vs actual | — | [H] S42 | Built |
| S-0949 | Driver budgeting + rolling reforecast | — | [H] S44 | Built |
| S-0950 | FP&A dashboard | KPIs, runway, scenarios, sensitivity | [H] S45 | Built |
| S-0951 | NL what-if scenarios | "Hire 5 reps in Q2 + 4% price" → modeled P&L/cash, cited (FPA E3) | [H] S47; S48; [D2] FPA Group E; FTP §1 M8 | Built; none; FPA #4 → nl-copilot |
| S-0952 | FP&A Copilot | Allowlisted metrics; model never writes SQL; abstains outside the list | [H] S43 | Built; AI down |
| S-0953 | NL for processing + FP&A | Owner directive, cross-cutting | [H] S42 §2 | Directive |
| S-0954 | 13-week cash forecast | Start = CHECKING/SAVINGS balances; AR/AP by due date; weekly roll; per entity or consolidated; drill-down; low-water negative-week warning (BC D1) | [H] S40; [D2] BC Group D | Built; BUILT (`lib/cash/forecast.ts`) |
| S-0955 | Driver cash forecast, obligations, trend | — | [H] S45; S49 | Built |
| S-0956 | Proactive CFO agent | GATE 9b | [H] D40 Part VII | OPEN |
| S-0957 | Cross-tenant benchmarking | GATE 9d | [H] D40 Part VII | OPEN |
| S-0958 | AI budget draft from prior actuals plus growth/driver assumptions | Trailing-12 by account × dept × entity; strips detected one-timers; applies growth/inflation/merit/price; basis per line (FPA A1) | [D1] CATv2 FP-A1; [D2] FPA Group A; FTP §1 M2/M5 | Crit 4.20; none; Top30 #14; none; FPA #1 (GATE 7); marquee |
| S-0959 | Seasonality-aware spreading | Uses own historical curve, not 1/12. FP-A2. | [D1] CATv2 FP-A2; [D2] FPA Group A | High 3.70; partial; partial (even only); FPA #1 |
| S-0960 | Driver-based budgeting (driver × rate) | Units × price, pipeline × win-rate, heads × quota, COGS % or per-unit, roster × loaded cost; AI suggests rates (FPA A3) | [D1] CATv2 FP-A3; COV #11; [D2] FPA Group A | Crit 4.10; none; Top30 #24; none; FPA #4 |
| S-0961 | Zero-based budgeting mode with justification scaffold | Justify from zero with prior detail + benchmarks (FPA A4) | [D1] CATv2 FP-A4; [D2] FPA Group A | Med 2.90; none; none; cost-transformation segment |
| S-0962 | Budget version management and plan-of-record lock | FP-A5 | [D1] CATv2 FP-A5; [D2] FPA Group A; FTP §1 M10 | High 3.85; none; Top30 #14; none; FPA #1 |
| S-0963 | Top-down vs bottom-up gap-to-target reconciliation | FP-A6 | [D1] CATv2 FP-A6; [D2] FPA Group A; FTP §1 M3 | High 3.30; none |
| S-0964 | Assumption library with automatic contractual step-ups | FP-A7 | [D1] CATv2 FP-A7 | Med 3.10; none |
| S-0965 | Rolling forecast (actuals-to-date + forecast-remaining) | FP-B1 | [D1] CATv2 FP-B1; [D2] FPA Group B | Crit 4.15; none; Top30 #15; none; FPA #3; marquee |
| S-0966 | Continuous forecast auto-tuning from actuals | Self-corrects drivers and reports how much and why it moved (FPA B2) | [D1] CATv2 FP-B2; [D2] FPA Group B | High 3.55; none |
| S-0967 | Reforecast-on-variance trigger | An exception-library class. FP-B3. | [D1] CATv2 FP-B3; [D2] FPA Group B | High 3.80; none; none; FPA #3 |
| S-0968 | Three-statement integrated forecast (P&L → BS → CF) | FP-B4 | [D1] CATv2 FP-B4; [D2] FPA Group B | Crit 4.00; none; none; deferred |
| S-0969 | Revenue / pipeline-driven revenue forecast | FP-B5 | [D1] CATv2 FP-B5; [D2] FPA Group B | High 3.40; none; none; segment |
| S-0970 | Cohort and unit economics (CAC / LTV / retention / payback) | FP-B6 | [D1] CATv2 FP-B6 | Med 3.10; none |
| S-0971 | Monthly indirect cash budget tied to the 13-week direct forecast | FP-B7; cross-lens tie-out NEW-FC2 | [D1] CATv2 FP-B7, §6.3; [D2] FPA Group B; FTP §2 M3 | High 3.50; partial; partial; deferred |
| S-0972 | Headcount / roster / fully-loaded compensation planning | FP-C1 | [D1] CATv2 FP-C1 | Crit 3.95; none |
| S-0973 | Compensation and merit-cycle modeling (affordability-checked) | Merit, promotions, bonus-pool funding, commissions vs attainment (FPA C2) | [D1] CATv2 FP-C2; [D2] FPA Group C | Med 3.15; none |
| S-0974 | Capex budgeting with capex → depreciation → cash bridge | FP-C3 | [D1] CATv2 FP-C3; [D2] FPA Group C | High 3.35; none; none; deferred |
| S-0975 | Real-time approaching/over-budget alerts (run-rate) | FP-D4 | [D1] CATv2 FP-D4; [D2] FPA Group D; FTP §1 M4/M12 | High 3.45; none |
| S-0976 | Commitment-aware budget consumption (encumbrance) | FP-D5 | [D1] CATv2 FP-D5; [D2] FPA Group D; P2P S9 M5/M12 | Med 3.05; none; none; needs PO model (GATE 11b) |
| S-0977 | Scenario modeling (base / upside / downside) | FP-E1 | [D1] CATv2 FP-E1; [D2] FPA Group E | Crit 3.90; none; Top30 #24; none; FPA #4 |
| S-0978 | Sensitivity / tornado chart on EBITDA and cash drivers | FP-E2 | [D1] CATv2 FP-E2 | High 3.30; none |
| S-0979 | Natural-language what-if → modeled P&L/cash | FP-E3 → PW5 | [D1] CATv2 FP-E3 | High 3.60; none |
| S-0980 | Goal-seek / target-driven planning | FP-E4 | [D1] CATv2 FP-E4; [D2] FPA Group E | Med 3.00; none |
| S-0981 | Monte-Carlo ranges (P10 / P50 / P90) | FP-E5 | [D1] CATv2 FP-E5 | Low 2.55; none |
| S-0982 | Department budget collaboration and submission workflow | FP-F1 | [D1] CATv2 FP-F1; [D2] FPA Group F | High 3.35; none; none; deferred (gate #9) |
| S-0983 | Budget approval / ratification workflow (SoD-bound) | FP-F2 | [D1] CATv2 FP-F2; [D2] FPA Group F | High 3.30; none; none; gate #9 |
| S-0984 | Budget change log and audit trail | FP-F3 | [D1] CATv2 FP-F3; [D2] FPA Group F | Med 3.00; none |
| S-0985 | Budget-owner nudges and deadline chase | FP-F4 | [D1] CATv2 FP-F4 | Med 2.85; none |
| S-0986 | Benchmark vs peers / industry | FP-G5 | [D1] CATv2 FP-G5 | Med 2.80; none |
| S-0987 | Long-range plan (3–5 yr) refreshed off actuals | Refreshes base each close (FPA H1) | [D1] CATv2 FP-H1; [D2] FPA Group H | High 3.25; none; none; PE segment |
| S-0988 | Reusable deal / ad-hoc model templates | FP-H3 | [D1] CATv2 FP-H3; [D2] FPA Group H | Med 2.95; none |
| S-0989 | 13-week direct cash forecast (multi-entity, multi-bank) | Bank balances + AP due dates + AR expected collections + debt service + payroll, by entity and consolidated; flags shortfalls. E2 / BC-D1. | [D1] CATv1 E2; CATv2 BC-D1; CFO #6 | High 3.75; built |
| S-0990 | Behavior-adjusted forecast (predicted collection dates) | Per-customer days-to-pay history + promises-to-pay instead of due date (BC D2, AR C34) | [D1] CATv2 BC-D2, AR-C34; [D2] BC Group D; AR Group F; FTP §2 M5/M14 | High 3.45; none/partial; Top30 #15; MISSING/PARTIAL; BC Tier 2 #6 |
| S-0991 | Scheduled-outflow overlay (payroll / debt / tax / recurring) | BC-D3 | [D1] CATv2 BC-D3 | Crit 3.70; none; Top30 #15 |
| S-0992 | Cash-requirement safety alert for payroll and debt service | Projected cash vs dated obligations; graduated alert (BC C3) | [D1] CATv2 BC-C3; [D2] BC Group C; FTP §2 M12 | Crit 3.75; none; MISSING; BC Tier 2 #5 |
| S-0993 | Cash scenario / what-if with funding recommendation | BC-D4 | [D1] CATv2 BC-D4; [D2] BC Group D; FTP §2 M11 | High 3.30; none; MISSING |
| S-0994 | Sweep / idle-cash optimization | Propose only; never moves money. BC-C4. | [D1] CATv2 BC-C4; CFO #6 | High 3.25; none |
| S-0995 | Forecast with separate actual / committed / AI-estimated layers | — | [D1] GAP §3B #13 | T2; partial |
| S-0996 | Forecast narrative | M7 | [D1] MATRIX §2 | none |
| S-0997 | Budget entry grid + copy-prior-year + even 1/12 spread + BvA | Per company/dept; variance, %, favorability; per-period or full year; consolidated | [D2] FPA Part 2 ground truth | Built (thin) |
| S-0998 | Assumption library + contractual step-up auto-detection | Merit %, inflation, tax rates, benefit loads; rent/SaaS/insurance escalators (FPA A7) | [D2] FPA Group A | none |
| S-0999 | Cohort & unit economics | CAC, LTV, retention curves, contribution margin, payback (FPA B6) | [D2] FPA Group B | none; subscription segment |
| S-1000 | Headcount / roster / comp planning | Current + planned hires by role/dept/entity, start dates, base, bonus, commission, fully-loaded cost; phases by start month (FPA C1) | [D2] FPA Group C | none; deferred (payroll/HR seam) |
| S-1001 | Versioned, dimensional BvA with drill-through | Vs active version, prior year, prior forecast; materiality heat; drill to journal lines (FPA D1) | [D2] FPA Group D | partial; FPA #2 |
| S-1002 | Sensitivity / tornado | e.g. "±3% price = ±$1.4M EBITDA" (FPA E2) | [D2] FPA Group E | none |
| S-1003 | Monte-Carlo / probabilistic ranges | P10/P50/P90 (FPA E5) | [D2] FPA Group E | none; segment |
| S-1004 | Budget-owner nudge / deadline chase + waiting-on board | Chase (FPA F4) | [D2] FPA Group F | none |
| S-1005 | Value-creation / equity bridge + MOIC/IRR | PE hold-period returns (FPA H2) | [D2] FPA Group H | none; PE segment |
| S-1006 | Forecast accuracy / bias tracking | Backtest; feeds auto-tune and autonomy dial (FPA K2) | [D2] FPA Group K; FTP §2 M4/M14 | none |
| S-1007 | Prior budget / version lookup; ingest board target letter | Retrieval / extraction | [D2] FTP §1 M13, M1 | NONE ⭐NEW (minor) |
| S-1008 | Scheduled-outflow overlay | Payroll schedule (mig 069), loan amortization, tax estimates, recurring drafts (BC D3) | [D2] BC Group D | MISSING; BC Tier 2 #5 |
| S-1009 | AP-driven cash-requirement forecast | Open payables by due date net of discounts into the 13-week forecast (AP I6) | [D2] AP Group I | PARTIAL; AP #6 |
| S-1010 | Inflow/outflow predictability classification | Contractual vs discretionary vs one-time | [D2] FTP §2 M2 | NONE ⭐NEW |
| S-1011 | Forecast narrative + assumptions-changed diff | e.g. "Why cash dips in wk 6" | [D2] FTP §2 M7 | NONE ⭐NEW |
| S-1012 | Reforecast orchestration each close | Actualize → roll forward → re-run covenant/cash → funding exception | [D2] FTP §2 M9 | NONE |
| S-1013 | Deposit-timing / float optimization | Optimization (BC F4) | [D2] BC Group F | MISSING; deferred |
| S-1014 | FX exposure / multi-currency seam | Balances by currency; net open position (BC F3) | [D2] BC Group F | Seam-only; deferred |

## Dashboards per role & team performance

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 116 | KPI dashboards (configurable by role) | Configurable by role (Jirav) | Audit #116 (Cat 5); BuildSpec v4.3 §04 Reporting, §20; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P0-BLOCKER |
| 153 | Dashboard — TTM revenue metric | MD9 note: dashboard wired Session 8 | Audit #153 (Cat 7); BuildSpec v4.3 §09; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅ |
| 154 | Dashboard — Pending review count (receipts/bills/JEs breakdown) | MD9 note: dashboard wired Session 8 | Audit #154 (Cat 7); BuildSpec v4.3 §09; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅ |
| 155 | Dashboard — EBITDA metric | MD9 note: dashboard wired Session 8 | Audit #155 (Cat 7); BuildSpec v4.3 §09; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅ |
| 156 | Dashboard — Active companies count | MD9 note: dashboard wired Session 8 | Audit #156 (Cat 7); BuildSpec v4.3 §09; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅ |
| 157 | Dashboard — 30-day processing volume chart | MD9 note: dashboard wired Session 8 | Audit #157 (Cat 7); BuildSpec v4.3 §09; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅ |
| 158 | Dashboard — Live activity feed | MD9 note: dashboard wired Session 8 | Audit #158 (Cat 7); BuildSpec v4.3 §09; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅ |
| 159 | Dashboard — Company summary table (per-entity pending, AI accuracy, sync status) | MD9 note: dashboard wired Session 8 | Audit #159 (Cat 7); BuildSpec v4.3 §09; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ✅ |
| 285 | Custom KPI creation and tracking |  | Audit #285 (Cat 13); BuildSpec v4.3 §04, §23; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 286 | KPI dashboards configurable by role |  | Audit #286 (Cat 13); BuildSpec v4.3 §04, §23; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 336 | Stack Rankings — Transaction Volume (Receipts, Bills, JEs, Total) | Receipts, bills, JEs, total | Audit #336 (Cat 17); BuildSpec v4.3 §24, §08; MD9 Part V | Apr-26 audit: PARTIAL; MD9: not in MD9 register |
| 337 | Stack Rankings — Dollar Volume (Receipt $, Bill $, JE $, Total $, Avg $/Txn) | Receipt $, bill $, JE $, total $, avg $/txn | Audit #337 (Cat 17); BuildSpec v4.3 §24, §08; MD9 Part V | Apr-26 audit: MISSING; MD9: not in MD9 register |
| 338 | Stack Rankings — Companies Managed (count, assigned entities, txns/company, backlog) | Count, assigned entities, txns/company, backlog | Audit #338 (Cat 17); BuildSpec v4.3 §24, §08; MD9 Part V | Apr-26 audit: MISSING; MD9: not in MD9 register |
| 339 | Stack Rankings — Timeliness (avg time/txn, same-day %, within 24hr %, overdue, trend) | Avg time/txn, same-day %, within 24h %, overdue, trend | Audit #339 (Cat 17); BuildSpec v4.3 §24, §08; MD9 Part V | Apr-26 audit: MISSING; MD9: not in MD9 register |
| 340 | Stack Rankings — 5 time periods (Daily, Weekly, Monthly, Quarterly, Yearly) | Daily/Weekly/Monthly/Quarterly/Yearly | Audit #340 (Cat 17); BuildSpec v4.3 §24, §08; MD9 Part V | Apr-26 audit: MISSING; MD9: not in MD9 register |
| 341 | Stack Rankings — Status badges (On Fire, On Track, Improving, Behind) | On Fire / On Track / Improving / Behind | Audit #341 (Cat 17); BuildSpec v4.3 §24, §08; MD9 Part V | Apr-26 audit: MISSING; MD9: not in MD9 register |
| 342 | Billing Efficiency — production employees hrs billed vs 37.5hr target, stack-ranked |  | Audit #342 (Cat 17); BuildSpec v4.3 §24, §08; MD9 Part V | Apr-26 audit: MISSING; MD9: not in MD9 register |
| 343 | Billing Efficiency — <70% utilization for 2 periods = flagged |  | Audit #343 (Cat 17); BuildSpec v4.3 §24, §08; MD9 Part V | Apr-26 audit: MISSING; MD9: not in MD9 register |
| S-1015 | Dashboard: 4 headline metrics (TTM revenue, pending review by receipts/bills/JEs, EBITDA, active companies), 30-day processing volume chart, live activity feed, company summary table (pending, AI accuracy, sync status) |  | BuildSpec v4.3 §09 |  |
| S-1016 | Team stack rankings: Transaction Volume, Dollar Volume, Companies Managed, Timeliness; badges On Fire/On Track/Improving/Behind; Daily/Weekly/Monthly/Quarterly/Yearly |  | BuildSpec v4.3 §24 |  |
| S-1017 | Department P&L snapshot inside the department detail panel |  | Handoff S36 §4 |  |
| S-1018 | Dashboard per user tier | Each tier's dashboard defined | [H] OD | Owner directive; process agent to design |
| S-1019 | Admin can rearrange dashboards | — | [H] OD | Owner directive |
| S-1020 | No big blue banner | Opens useful and visually appealing | [H] OD | Owner directive |
| S-1021 | Per-company work board | Queues, close status, cash/AR/AP; consolidated strip | [H] S48 | Built |
| S-1022 | Team Performance KPIs | 30+ KPIs, quality-gated, three lenses | [H] S42 (mig 074) | Built |
| S-1023 | Accounting-manager KPI dashboard | Throughput by count and $, adherence %, leaderboard | [H] S50 | Rebuilt |
| S-1024 | Operations overview + client health | — | [H] S39; S40 | Built |
| S-1025 | Ranked Action Inbox | — | [H] S45 | Built |
| S-1026 | Unified exception queue + resolve / dismiss | — | [H] S39 | Built |
| S-1027 | Density mode by role | Cockpit vs report | [H] CLAUDE.md | Binding |
| S-1028 | Real-time multi-entity cash-position dashboard | Morning cash positioning across 10–20 entities and 6–8 banks. BC-C1. | [D1] CATv2 BC-C1; CFO Part 1; [D2] BC Group C | High 3.50; built; BUILT (`/api/cash`) |
| S-1029 | Team performance dashboard | Throughput per bookkeeper (`/team`, `FPB-team-performance`) | [D1] COV #22 | built (de11940) |
| S-1030 | Workload / capacity view (machine and humans) | Live counts and aging of the queue by entity / workstream / tier / assignee; throughput vs inflow; projected time-to-clear; warns when the queue grows faster than it clears. MGR B5 / GL-F4. | [D1] MGR B5; CATv2 GL-F4 | Med 3.15; partial |
| S-1031 | Autonomy-rate and exception-backlog metrics | Autonomy rate, override rate, errors caught pre-post vs escaped to review vs escaped to close, backlog aging, rework rate — by entity / workstream / tier, trended. These govern the dials. | [D1] MGR B8; CATv1 H4 | partial |
| S-1032 | Machine-vs-human attribution filter view | "Everything the machine posted autonomously", "what a human overrode", "what agent X did" | [D1] MGR B2 | partial |
| S-1033 | Error rate and error type per person over time | Training signal | [D1] MGR A5 | — |
| S-1034 | Review-queue depth and age per reviewer | Time-in-review; which preparers generate the most review points | [D1] FIRM B3 | — |
| S-1035 | Daily standup / desk-check view | What's stuck, waiting on client, at risk | [D1] MGR A3 | — |
| S-1036 | AI performance summaries (ledger-grounded, no invented numbers) | NEW-TP1 | [D1] CATv2 §6.3 | Med–High; none |
| S-1037 | Fairness / anti-gaming sentinel | Throughput up while quality down; trivial-batch inflation; review skipping; rework outliers | [D1] CATv2 §6.3; [D2] FTP §7 M4 | none; spec ⭐NEW; TP top-3 (b) |
| S-1038 | Coaching-pattern detection (recurring-error training signal) | NEW-TP3 | [D1] CATv2 §6.3 | none |
| S-1039 | Capacity-vs-load / time-to-clear prediction | NEW-TP4 | [D1] CATv2 §6.3; [D2] FTP §7 M5 | none; spec ⭐NEW |
| S-1040 | Instrumentation-health meta-metric | NEW-TP5 | [D1] CATv2 §6.3; [D2] FTP §7 M3 | none; partial ⭐NEW |
| S-1041 | Bookkeeper / processor work queue | Lowest-confidence-first feed; AP inbox side-by-side; duplicate warnings; missing-receipts count; "waiting on" board; uncategorized queue; recurring batch at period open; cash-application confirms | [D1] BKP Part 2 & 3 | persona need |
| S-1042 | Accounting-manager supervision cockpit | Close command center; confidence-tiered queue with sampling; pre-post flags; workload view; attribution filter; autonomy metrics; kill switch | [D1] MGR Part B | persona need |
| S-1043 | Controller/CFO cockpit | Morning multi-bank cash; positive-pay exceptions; covenant headroom; IC imbalance; close checklist status; 13-week forecast; board/lender package | [D1] CFO Parts 1–2 | persona need |
| S-1044 | CPA / assurance view | M-1 bridge; pre-scored manual-JE population; SoD matrix; PBC pack; nexus exposure; 1099 readiness; FA roll | [D1] CPA Part B | persona need |
| S-1045 | Scorecard / labor-cost / job-cost narrative | M7 | [D1] MATRIX §2 | none |
| S-1046 | NL cash query | "Consolidated position by entity; which accounts breach minimum this week" | [D2] P2P S3 M8; FTP §2 M8 | NONE ⭐NEW |
| S-1047 | Close analytics | Cycle time, bottlenecks, autonomy rate, override/error rate, escaped-vs-caught errors, backlog aging; governs autonomy dials (GLC I3) | [D2] GLC Group I | NOT BUILT |
| S-1048 | Team performance KPI compute + guard | Quality-gated, difficulty-weighted KPIs; `performance_config` (mig 074); `/api/team-performance`; work-family classification; nightly `performance_daily` rollup | [D2] FTP §7 M2/M9 | compute built; dashboard partial |
| S-1049 | AI performance summaries | Grounded strictly in computed KPIs | [D2] FTP §7 M6 | spec ⭐NEW; TP top-3 (a) |
| S-1050 | Scorecard-movement narrative | Preparer↔reviewer pairing narrative | [D2] FTP §7 M7 | spec ⭐NEW |
| S-1051 | NL team queries | RBAC-scoped with drill-through | [D2] FTP §7 M8 | → nl-copilot |
| S-1052 | Team-performance governance | Never auto-determines pay/ranking/discipline; viewing scorecards is logged | [D2] FTP §7 M10 | spec |
| S-1053 | Coaching-pattern detection + load-balancing / backup-reviewer recommendation | Recommendations | [D2] FTP §7 M11 | spec ⭐NEW |
| S-1054 | Team proactive alerts | Rising override rate, backlog outgrowing clear rate, key-person concentration, autonomy-up-while-errors-up (kill-switch trigger) | [D2] FTP §7 M12 | spec ⭐NEW |
| S-1055 | Drill-through to `action_log` rows; per-tenant weight/band memory | Retrieval + config | [D2] FTP §7 M13/M14 | partial |

## Practice management

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 324 | Client relationship dashboard (close status, open items, staff) |  | Audit #324 (Cat 16); BuildSpec v4.3 §04 Practice, §26; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌/🔶; seq P6-FUTURE |
| 326 | Client transaction question workflow (ask → respond → resolve) |  | Audit #326 (Cat 16); BuildSpec v4.3 §04 Practice, §26; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌/🔶; seq P6-FUTURE |
| 327 | Integrated email client within platform |  | Audit #327 (Cat 16); BuildSpec v4.3 §04 Practice, §26; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌/🔶; seq P6-FUTURE |
| 328 | Email-to-task conversion |  | Audit #328 (Cat 16); BuildSpec v4.3 §04 Practice, §26; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌/🔶; seq P6-FUTURE |
| 329 | Task management with tags, assignments, due dates, subtasks |  | Audit #329 (Cat 16); BuildSpec v4.3 §04 Practice, §26; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌/🔶; seq P6-FUTURE |
| 330 | Workflow templates for repeatable processes |  | Audit #330 (Cat 16); BuildSpec v4.3 §04 Practice, §26; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ❌/🔶; seq P6-FUTURE |
| 331 | Management report generation (P&L, BS, KPIs, graphs in 4 clicks) |  | Audit #331 (Cat 16); BuildSpec v4.3 §04 Practice, §26; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌/🔶; seq P6-FUTURE |
| 332 | Report templates with client branding |  | Audit #332 (Cat 16); BuildSpec v4.3 §04 Practice, §26; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌/🔶; seq P6-FUTURE |
| 333 | Time tracking per client with auto-capture from Processor |  | Audit #333 (Cat 16); BuildSpec v4.3 §04 Practice, §26; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌/🔶; seq P6-FUTURE |
| 334 | Client properties and classification (service tier, industry) |  | Audit #334 (Cat 16); BuildSpec v4.3 §04 Practice, §26; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌/🔶; seq P6-FUTURE |
| 335 | Internal team chat linked to tasks |  | Audit #335 (Cat 16); BuildSpec v4.3 §04 Practice, §26; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌/🔶; seq P6-FUTURE |
| S-1056 | Practice tab: client intake, engagement tracking, automatic time capture when accountant works a client in Processor, estimates & proposals with AI, billing & revenue mgmt, staff utilization reporting |  | BuildSpec v4.3 §26 | Future (after Processor + MeritWork) |
| S-1057 | MeritWork engine: client/entity mgmt, projects/engagements, tasks (Kanban/list/calendar), time (start/stop, manual, automatic), billing (hourly/fixed/retainer/milestone/cost-plus), documents, workflow automation, dashboards | Suite Layer 1 | BuildSpec v4.3 §26 | Future |
| S-1058 | Tenant types | Accounting firms with clients, or end-user companies | [H] OD | Owner directive |
| S-1059 | Tenant manager delegates by client | — | [H] OD | Owner directive |
| S-1060 | Bookkeeper is the primary user | Automate nearly everything they do | [H] OD | Owner directive |
| S-1061 | Multi-company practice | Add company, assign members, "Owns onboarding" | [H] S48 (mig 121) | Built |
| S-1062 | Practice assignments; manager vs preparer scope | — | [H] S47 (mig 102 / 108) | Built |
| S-1063 | Per-user company assignments | `core.assignments` | [H] S42–S50 | Open |
| S-1064 | Context switcher | Platform / Practice / Book of Record | [H] S39 | Built |
| S-1065 | Company-scoped processing | Header picker, guard on 31 pages, selected company shown | [H] S47; S48 | Built |
| S-1066 | Practice / client management | Audit category 16 | [H] D30 | Partly built |
| S-1067 | Cross-client portfolio dashboard and close board | All N client books: close status (on-track / at-risk / late vs business-day-N), exceptions, review queues, profitability, deadlines; drill portfolio → client → task; reads live ledger state. G1. | [D1] CATv1 G1; FIRM B1/B2/C1 | 3.75; none; Gate 11a/10 |
| S-1068 | Firm cockpit: close and health across all client orgs | — | [D1] GAP §3D #26 | T3; partial (operator console) |
| S-1069 | Enforceable standardized close and onboarding playbooks | Firm-standard core with per-client variants, sequencing and hard gates. G2. | [D1] CATv1 G2; FIRM A3/B4 | 3.05; none |
| S-1070 | Staff ↔ client assignment grid | Preparer / reviewer / partner per client; tiers; audited re-assignment; key-person concentration; backup reviewer. G3. | [D1] CATv1 G3; FIRM A1/B8; [D2] FTP §5 M11 | 2.85; none; NONE ⭐NEW; practice top-3 (c) |
| S-1071 | Capacity, utilization and peak-load planning | Billable ÷ available; level the close calendar; model onboarding load separately | [D1] FIRM A2 | — |
| S-1072 | Realization and write-downs per client and per staffer | — | [D1] FIRM A7/B6 | — |
| S-1073 | Per-client profitability (practice-level P&L) | Fee vs fully-loaded cost of hours, ranked | [D1] FIRM B9 | — |
| S-1074 | Scope-creep detection on fixed-fee clients | Volume / entities / hours / exceptions vs the onboarding baseline; re-price evidence pack. NEW-PC4. | [D1] FIRM A9/B7; CATv2 §6.3 | none |
| S-1075 | Pricing models and estimated-hours model at onboarding | Fixed / hourly / value / tiered | [D1] FIRM A9 | — |
| S-1076 | Firm review hierarchy routing | Preparer → reviewer → partner; review notes; sign-off gates delivery of financials | [D1] FIRM A6 | — |
| S-1077 | AI pre-review | Auto tie-outs and anomaly flags so the reviewer sees only judgment items | [D1] FIRM B3; MATRIX §4 #30 | Top30 #30 |
| S-1078 | Cross-client exception sweep (QC) | NEW-PC1 | [D1] FIRM A8; CATv2 §6.3; [D2] FTP §5 M4 | none; Top30 #30; partial ⭐NEW; practice top-3 (a) |
| S-1079 | Portfolio close-slippage and capacity/peak-load prediction | Prediction | [D1] CATv2 §6.3; [D2] FTP §5 M5 | none; NONE ⭐NEW |
| S-1080 | Staff ↔ client assignment optimization with key-person backup | NEW-PC3 | [D1] CATv2 §6.3 | none |
| S-1081 | Engagement-letter / deliverable-pack drafting | NEW-PC5 | [D1] CATv2 §6.3 | none |
| S-1082 | White-label AI ledger for US accounting firms | Market white space | [D1] GAP §1 #5 | — |
| S-1083 | Practice identity / multi-client model | Prereq for the plane; substrate `/api/operations`, `/api/client-health` (single-org) | [D2] FTP §5 | NONE; GATE 10/11a |
| S-1084 | Firm standard COA / close-playbook mapping across clients | Applied across ~40 books | [D2] FTP §5 M2 | NONE ⭐NEW |
| S-1085 | Cross-client subledger / IC tie-out sweep | Sweep | [D2] FTP §5 M3 | partial ⭐NEW |
| S-1086 | Engagement letter / proposal / scope-change memo + client deliverable pack + status update drafting | Drafting | [D2] FTP §5 M6 | NONE ⭐NEW |
| S-1087 | Per-client profitability narrative + realization / scope-creep evidence pack | Narrative | [D2] FTP §5 M7 | NONE ⭐NEW |
| S-1088 | NL practice queries | "Which clients are behind / over-allocated / least profitable" | [D2] FTP §5 M8 | → nl-copilot |
| S-1089 | Close-to-deliver orchestration per client + agentic pre-review | Auto tie-outs; clears mechanical checks | [D2] FTP §5 M9 | NONE ⭐NEW; practice top-3 (b) |
| S-1090 | Practice autonomy governance | AI as supervised preparer in preparer → reviewer → partner chain | [D2] FTP §5 M10 | NONE ⭐NEW |
| S-1091 | Portfolio close-board alerting | On-track/at-risk/late, SLA breach, scope creep, realization drop, review bottleneck | [D2] FTP §5 M12 | NONE ⭐NEW |
| S-1092 | Firm playbook / SOP + prior-client-treatment retrieval | Retrieval | [D2] FTP §5 M13 | NONE ⭐NEW |
| S-1093 | Per-firm playbook memory + realization baseline | Learning | [D2] FTP §5 M14 | NONE ⭐NEW |

## AI agents & automation

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 356 | Settings — AI Usage Dashboard (cost by feature, by company, cache hit rate) | Cost by feature, by company, cache hit rate. MD9 note: keep (resale); **reads the Core gateway usage log — metering/caps are Core-owned (I.3), Books only surfaces** | Audit #356 (Cat 17); BuildSpec v4.3 §24, §08; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 357 | CPA Desk — in-app AI accounting advisor (slide-out, indigo theme) | Slide-out advisor. MD9 note: same engine brain (II.5) | Audit #357 (Cat 18); BuildSpec v4.3 §07, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 358 | CPA Desk — context awareness (screen, COA, GL rules, GAAP) | Knows screen, COA, GL rules, GAAP. MD9 note: same engine brain (II.5) | Audit #358 (Cat 18); BuildSpec v4.3 §07, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 359 | CPA Desk — quick-action buttons (categorization, GAAP, amortization, capitalize vs expense, GL lookup) | Categorization, GAAP, amortization, capitalize vs expense, GL lookup. MD9 note: same engine brain (II.5) | Audit #359 (Cat 18); BuildSpec v4.3 §07, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 360 | CPA Desk — set up recurring JE from AI response | MD9 note: same engine brain (II.5) | Audit #360 (Cat 18); BuildSpec v4.3 §07, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 361 | CPA Desk — every session audit-logged | MD9 note: same engine brain (II.5) | Audit #361 (Cat 18); BuildSpec v4.3 §07, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 362 | System Console — admin AI development interface (emerald theme) | MD9 note: optional/long-term | Audit #362 (Cat 18); BuildSpec v4.3 §07, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 363 | System Console — maintenance mode toggle | MD9 note: optional/long-term | Audit #363 (Cat 18); BuildSpec v4.3 §07, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 364 | System Console — NL change requests → Claude generates code diffs | MD9 note: optional/long-term | Audit #364 (Cat 18); BuildSpec v4.3 §07, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 365 | System Console — Apply/Preview/Reject buttons | MD9 note: optional/long-term | Audit #365 (Cat 18); BuildSpec v4.3 §07, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 366 | Suggest a Feature — user submission modal with status tracking |  | Audit #366 (Cat 18); BuildSpec v4.3 §07, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 367 | AI Learn From Every Correction — vendor pattern update on human correction | MD9 note: categorization.ts | Audit #367 (Cat 18); BuildSpec v4.3 §07, §24; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶; seq P6-FUTURE |
| 368 | AI Cost Transparency — per-feature, per-company usage tracking | MD9 note: sourced from the **Core AI gateway** usage log (per-tenant/user/feature); ai_audit_log is the local decision/audit trail, not the meter | Audit #368 (Cat 18); BuildSpec v4.3 §07, §24; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 419 | Hourly: Email Sync (M365 inbox → Claude parse → route → store → attach to JE) | M365 inbox → Claude parse → route → store → attach to JE. MD9 note: CORE | Audit #419 (Cat 22); BuildSpec v4.3 §19; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 420 | Daily 1:00 AM: Bank Feed Categorization (pull → match → auto-categorize → queue) |  | Audit #420 (Cat 22); BuildSpec v4.3 §19; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 422 | Monthly 1st 2:00 AM: Revenue Recognition (calc % → generate JEs → post → snapshot) |  | Audit #422 (Cat 22); BuildSpec v4.3 §19; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 424 | Continuous: Receipt Chase (event-driven push+SMS on CC transaction) |  | Audit #424 (Cat 22); BuildSpec v4.3 §19; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 425 | Daily: Vendor Compliance Check (scan for expiring COIs, send chase) |  | Audit #425 (Cat 22); BuildSpec v4.3 §19; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| S-1094 | Seven-stage pipeline for every source: Ingest → Extract → Categorize → Score → Review → Post → Audit | Sources: Plaid pull, M365 attachments, mobile captures, vendor invoice uploads, payroll imports, manual JEs, all normalized to a common transaction format | BuildSpec v4.3 §06 |  |
| S-1095 | Audit record per posting: approver, time, AI's original suggestion, what changed, model version, confidence, EBITDA impact estimate |  | BuildSpec v4.3 §06 stage 7, §16 |  |
| S-1096 | AI categorization returns GL account, vendor match, job suggestion, department, company and confidence; cache-first (target 80%+ hit rate) |  | BuildSpec v4.3 §07.1 |  |
| S-1097 | Document extraction (OCR) of receipts/invoices: vendor, total, date, line items, tax, payment terms, job/project references |  | BuildSpec v4.3 §07.2 |  |
| S-1098 | CPA Desk example: drafts amortization schedule + monthly JEs from a question ("amortize BuilderTrend annual subscription") | Knows COA, GL classification rules, active jobs, vendor history, recent transactions | BuildSpec v4.3 §07.4 |  |
| S-1099 | System Console: NL change → config diff → preview/apply/reject; session info, context panel, change history with rollback, activity log |  | BuildSpec v4.3 §07.7 |  |
| S-1100 | AI Usage Dashboard: usage + cost by feature (categorization, OCR, CPA Desk, forecasting, compliance, Console), by company, cache hit rate (target 80%+), optimization recommendations | Est. ~$50–135/mo for 17 companies; ~$1.10/company/month | BuildSpec v4.3 §07, §24 |  |
| S-1101 | Daily 1:00 AM bank feed categorization job: pull uncategorized → 3-step matching → auto-categorize high confidence → queue rest |  | BuildSpec v4.3 §19 |  |
| S-1102 | AI gateway as a shared Core service: metering, model-price config, usage log, per-tenant/per-user budget counters, cap enforced on combined suite usage, usage/cost dashboard; no module holds an API key | Degrade/block per overage policy; per-tier $ caps are config | MD9 I.3, GATE 1 | DONE (GATE 1) |
| S-1103 | One AI JE engine, two front doors (NL composer + inbound categorizer) producing a proposed balanced JE with real accounts, dimensions, rationale, confidence | Context per call: COA, open jobs, departments, vendors, customers, recent similar entries, per-company policy, GAAP | MD9 II.5 |  |
| S-1104 | NL composer downstream actions: queue a check to check-processing queue, create amortization schedule, create depreciation schedule, create recurring JE | e.g. "Cut a check to [owner] as return of capital $50,000" → JE + queued check with JE attached; distinguishes return of capital vs distribution | MD9 II.5 | Composer BUILT; downstream actions partial |
| S-1105 | Clarify-before-booking: ask ONE disambiguating question when economic substance is ambiguous | e.g. discount vs company-funded display advertising (full revenue + prepaid marketing amortized 60 mo; ASC 720-35 flag) | MD9 II.5, X.2 | Guardrail |
| S-1106 | Prediction layer on both doors: capex (life >1 yr & above threshold → asset + depreciation), prepaid (→ asset + amortization), deferred revenue (customer prepayment → liability); per-company thresholds; always a flagged proposal | Built through gateway with deterministic fallback | MD9 II.5, GATE 3, XI.10 | BUILT |
| S-1107 | Auto-post OFF by default; controller can enable per task type under thresholds for high-confidence + trusted vendor; never a global "let AI run" switch | Per-task autonomy dial gated on decision-log accuracy | MD9 II.5, VIII.7 | Guardrail |
| S-1108 | Segregation of duties on the AI itself: same agent never both originates and approves a payment or material entry |  | MD9 VIII.7 | Guardrail |
| S-1109 | Non-standard GAAP treatments flagged; override requires documented reason |  | MD9 II.5, VIII.7 |  |
| S-1110 | AI Decision Log & Explainability: every AI action logs inputs/sources, proposed output, confidence, reasoning, rejected alternative, human disposition; page /ai-decisions | Nothing AI-originated posts unlogged | MD9 GATE 3, XI.9 (mig 039) | BUILT |
| S-1111 | Two-phase categorizer: vendor-pattern cache (Levenshtein) then Claude via gateway returning real account_id + vendor + department + class + confidence; learning loop upserts pattern on every confirmed post |  | MD9 II.5, XI.9 | BUILT |
| S-1112 | GATE 4 M365 ingestion: per-tenant list of dedicated mailboxes; one Core-owned Azure app locked by Exchange application-access policy; pull messages+attachments, store raw docs, dedupe, attribute to tenant | Done when emailed invoice → balanced proposed entry with no keying | MD9 GATE 4 | OPEN (blocked on Azure creds then) |
| S-1113 | Document-to-everything ingestion: bank/loan statements, payroll registers, insurance dec/COI pages (auto-update vendor compliance), tax notices, K-1s |  | MD9 GATE 4 | OPEN |
| S-1114 | GATE 5 confidence routing: known vendor + high confidence auto-approves under per-tier threshold; new/low/unusual → review; corrections train per-tenant model |  | MD9 GATE 5 | OPEN |
| S-1115 | Fraud/anomaly detection: duplicate payments, vendor bank-detail changes, round-dollar/just-under-threshold, split invoices, ghost vendors |  | MD9 GATE 9a | OPEN |
| S-1116 | Conversational financial forensics (9b): "why did margin drop at X in March?" traced to source transactions with drill-through |  | MD9 GATE 9b | OPEN |
| S-1117 | Proactive CFO agent feed (9b): DSO/DPO drift, margin erosion, recurring-spend creep, vendor price increases, covenant-trajectory warnings |  | MD9 GATE 9b | OPEN |
| S-1118 | Per-tenant learning loop and anonymized opt-in cross-tenant benchmarking (9d) |  | MD9 GATE 9d | OPEN |
| S-1119 | Open/standard rules backlog: early-payment/purchase discounts, use-tax self-assessment, credit-memo application/overpayments, settlement reversal/void, opening-balance/TB import, 1099 accumulation |  | MD9 XI.8 §3 | OPEN |
| S-1120 | Per-tenant, per-task autonomy dial + kill switch on every surface that can auto-act; batch disposition shown (auto-posted vs queued vs flagged) | Auto-post off by default | Platform Design Criteria §4, §3 |  |
| S-1121 | AI decision log surfaced as a first-class readable log (inputs, confidence, reasoning, human decision) |  | Platform Design Criteria §4 |  |
| S-1122 | AI metering visible where relevant, per-tenant budgets with hard ceilings |  | Platform Design Criteria §4 |  |
| S-1123 | AI extraction emits structured facts incl. invoice/PO number and contract terms; classification determines transaction type, rail, judgment flags (prepaid, capex, deferred, job→WIP, lease, non-standard GAAP) | Layers 1–6 | Posting Engine Spec Part C |  |
| S-1124 | Vendor/customer master deduplication & enrichment ("Home Depot" / "The Home Depot #4501" resolve to one master) |  | Posting Engine Spec Part H | New AI capability |
| S-1125 | AI-drafted outbound communications: dunning emails, W-9/COI chase, missing-receipt requests, payment confirmations (human sends) |  | Posting Engine Spec Part H | New AI capability |
| S-1126 | AI gateway thresholds: soft warn ~80% of budget (admin warned), hard cap degrades (cheaper model / cached / queued) or blocks with "AI budget reached"; per-call max_tokens cap, per-user/tenant rate limits, concurrency limit | Response states ok/warn/degraded/blocked | Suite Architecture §3A.4–3A.5 | DONE (GATE 1) |
| S-1127 | AI governance | AI proposes, engine posts, human approves; auto-post OFF; per-task dial; no global switch; separation of duties on the AI | [H] ANCHOR §3; D40 VIII.7 | Canon |
| S-1128 | Every AI action logged | Decision log + audit attribution (machine vs human) | [H] D40 (mig 039); S39 | Built |
| S-1129 | Confidence tiers | Auto / review / escalate | [H] S39 | Built |
| S-1130 | M10 autonomy dial + kill switch | — | [H] S43 (mig 075) | Built |
| S-1131 | M9 supervised agent runner | AP intake loop; order-to-cash and pay-run recipes next | [H] S46 (mig 096) | Framework + 1 loop |
| S-1132 | M14 learned preferences | Informs proposals, never posts or approves | [H] S46 (mig 097) | Opened |
| S-1133 | M13 search | Full-text; embeddings deferred | [H] S43; S46; S50 | Built |
| S-1134 | M8 ⌘K command bar | Processing / analytical / navigation lanes | [H] S43 | Built |
| S-1135 | Core AI gateway | Metering, budgets, caps | [H] D10; ANCHOR §2; [D1] INT §2.8; MATRIX §0 | Built (GATE 1); built (Gate 1) |
| S-1136 | Per-tenant AI usage dashboard; tier budgets | — | [H] D40 Part VII GATE 10; Part X | Open |
| S-1137 | Graceful AI-down | — | [H] S48 | Built |
| S-1138 | Control exception library | Always-on, $-quantified exceptions in `/exceptions` with a one-click remediation draft; tiering, materiality and suppression/learning; dedupes with the Projects Billing Integrity Auditor on `source_ref`. PW1 / H1. | [H] ANCHOR §5; S41–S48; [D1] CATv2 PW1; CATv1 H1 | Built; EC-5/8/9/11/13 remain; Crit 4.45; partial; FPB-financial-control-exceptions (Gate 9) |
| S-1139 | AI capability catalog / 14×24 matrix | ~303 capabilities | [H] S41; S43 | Governance |
| S-1140 | Conversational forensics | GATE 9b | [H] D40 Part VII | OPEN |
| S-1141 | Autonomous-workforce framing | — | [H] ANCHOR §1; S39 | Awaiting ratification (task #19) |
| S-1142 | Exception detector classes | Built: EC-1 dup payment, EC-2, EC-3 IC balance, EC-4 uncategorized leakage, EC-7 nexus, EC-8, EC-10 anomalous JE, EC-12, rev-rec, bill anomaly, cutoff, cash application. Remaining: EC-5/6/9/11/13 (incl. EC-9 book-to-tax). | [D1] CATv2 §3; COV #25 | partial |
| S-1143 | Confidence-tier routing, autonomy dial, materiality and kill switch | `scoreToTier` → real disposition; per task / entity / global dial loosened only as earned; $-materiality scaling; sampling rights in the trusted band; immediate granular kill switch degrades to propose-only. PW4 / H4. | [D1] CATv2 PW4; CATv1 H4; MGR B3/B9/B10 | Crit 4.20; partial; Top30 #1 |
| S-1144 | Kill-switch triggers | Override/error spike, material error escaped, miscalibrated confidence, model/version change, SoD or log integrity failure, unclearable backlog, supervisor's gut | [D1] MGR B10 | — |
| S-1145 | Decision log for every AI proposal | Inputs, assumptions, confidence, approver → `ai_decisions` / `action_log`. PW6. | [D1] CATv2 PW6; CFO #10; [D2] BC Group F; FPA Group K | High 3.85; built (infra); BUILT (infra); no FP&A writers |
| S-1146 | Document / answer chase orchestration | Any item blocked on a doc, approval or answer gets a drafted ask in the operator's voice, auto-follow-up, and a single "waiting on" board. PW7 / CORE-9 / G4. | [D1] CATv2 PW7; BKP CORE-9; FIRM B5 | High 3.40; partial (send blocked Gate 4) |
| S-1147 | Universal NL command surface / FP&A copilot | One router and allowlist with citations, covering every segment (`FPB-nl-copilot`). No parallel NL boxes. PN-2 / PW5. | [D1] MATRIX §3a PN-2; CATv2 PW5; [D2] FTP intro; P2P B.4 | Crit; partial; Top30 #12; spec; cross-cutting |
| S-1148 | Knowledge and retrieval spine | Semantic search over ledger, reports, contracts, vendors, customers, collections history, assets and jobs; GAAP / tenant-policy Q&A; grounded and cited. Includes vendor-360 / customer-360 and source-doc pull for a bank line. PN-1. | [D1] MATRIX §2, §3a PN-1 | Crit; none; Top30 #18 |
| S-1149 | Per-object "explain this X" narrative | JE, bill, invoice, rec item, payment, consolidation, scorecard, forecast. PN-3. | [D1] MATRIX §3a PN-3 | High; none |
| S-1150 | Named agentic loops | AP, vendor onboarding, morning cash, order-to-cash, pay run, expense, procure-to-pay, close run, conversion playbook, provision run, per-client close-to-deliver. PN-4. | [D1] MATRIX §3a PN-4 | Crit; partial |
| S-1151 | Platform-wide learning / personalization memory | Tenant close cadence, report/KPI/tone preferences, method + SSP library, asset defaults, per-entity and per-firm playbook memory. PN-5. | [D1] MATRIX §3a PN-5 | High; partial |
| S-1152 | Shared business-context memory read by every agent | What each entity does | [D1] GAP §1 #2, §3B #20 | T2; partial (vendor memory only) |
| S-1153 | MCP server | Read access plus role-scoped write that becomes proposals, so Claude can work the books | [D1] GAP §3A #6 | T1 Now; missing |
| S-1154 | Scheduler (Vercel crons + secret) | For agents, report packs and nightly checks | [D1] GAP §3A #2 | T1 Now; missing |
| S-1155 | Plain-English custom checks compiled to deterministic rules | — | [D1] GAP §3B #10 | T2; missing |
| S-1156 | Audit agents that check other agents | Compare instructions and output to policy → monthly control report | [D1] GAP §3B #18 | T2; missing |
| S-1157 | AI eval suite run on every release | Regression guard for every AI feature | [D1] GAP §3B #19 | T2; missing |
| S-1158 | Verify AI is actually on in production | Anthropic org status | [D1] GAP §3A #8 | T1 Now; verify |
| S-1159 | Route the 7 direct-Anthropic route handlers through the gateway | `receipts/categorize`, `bank-feed/categorize`, `journal-entries/compose`, `categorize`, `bills/parse`, `bills/intake`, `posting/predict` | [D1] MATRIX §5; INT F1 | governance must-fix |
| S-1160 | Calibrated confidence and model-version regression watch | Confidence must match accuracy; notify and watch metrics when the model changes | [D1] MGR B9 | — |
| S-1161 | Voice ("what's cash across the group?") | Market white space | [D1] GAP §3D #32 | T3; missing |
| S-1162 | Supervision & autonomy control plane | Wire `scoreToTier` into real disposition (auto/review/escalate); per-task/entity autonomy dial (OFF default); tenant materiality object; batch-accept safest tier (GLC J2/J3, BC F9, FPA K4) | [D2] GLC Group J; BC Group F; FPA Group K | PARTIAL/MISSING; GLC #1 "immediate #1 pick" (GATE 5) |
| S-1163 | Kill-switch / autonomy throttle | Task/entity/global drop to propose-only on error spike or model change; degrades gracefully (GLC J5) | [D2] GLC Group J | NOT BUILT; GLC #1 |
| S-1164 | Machine-vs-human attribution timeline UI | Filter by autonomous vs overridden vs agent X; actor, confidence, reason (GLC J1) | [D2] GLC Group J | PARTIAL; GLC #8 |
| S-1165 | AP agent | Inbox → extract → code → match → route → schedule → pay → reconcile | [D2] P2P S1 M9 | NONE ⭐NEW |
| S-1166 | Vendor-onboarding agent | W-9 → TIN match → COI → bank verify → activate, chasing gaps | [D2] P2P S2 M9 | NONE ⭐NEW |
| S-1167 | Morning-cash agent | Pull balances → flag stale feeds → net position → propose funding/sweep | [D2] P2P S3 M9 | NONE ⭐NEW |
| S-1168 | Order-to-cash agent | Quote → invoice → deliver → collect | [D2] P2P S4 M9 | NONE ⭐NEW |
| S-1169 | Customer onboarding + credit-review agent | Collect docs → references → propose limit/terms | [D2] P2P S6 M9 | NONE ⭐NEW |
| S-1170 | Pay-run agent | Build run → route approval → fund check → release (human) → remit → reconcile | [D2] P2P S7 M9 | partial ⭐NEW |
| S-1171 | Expense agent | Capture → code → match receipt → approve → reimburse | [D2] P2P S8 M9 | NONE ⭐NEW |
| S-1172 | Procure-to-pay agent | Requisition → PO → receive → 3-way match → bill | [D2] P2P S9 M9 | NONE ⭐NEW |
| S-1173 | Autonomous close-run agent | Gather, propose, chase, auto-verify | [D2] R2R S2 M9 | partial |
| S-1174 | End-to-end reconcile agent | Pull feed, match, draft adjustments, surface exceptions, finalize | [D2] R2R S3 M9 | partial |

## Onboarding & migration

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 369 | Org Setup Wizard — Step 1: Organization Profile | MD9 note: setup wizard | Audit #369 (Cat 19); BuildSpec v4.3 §08; MD9 Part V | Apr-26 audit: MISSING; MD9: ✅; seq P4-MED |
| 370 | Org Setup Wizard — Step 2: Connect Banking (Plaid) | MD9 note: entity-first connect + per-account GL/label mapping (Session 24) | Audit #370 (Cat 19); BuildSpec v4.3 §08; MD9 Part V | Apr-26 audit: MISSING; MD9: ✅; seq P4-MED |
| 371 | Org Setup Wizard — Step 3: Portfolio Companies |  | Audit #371 (Cat 19); BuildSpec v4.3 §08; MD9 Part V | Apr-26 audit: MISSING; MD9: ✅; seq P4-MED |
| 372 | Org Setup Wizard — Step 4: Chart of Accounts (251 seed accounts) |  | Audit #372 (Cat 19); BuildSpec v4.3 §08; MD9 Part V | Apr-26 audit: MISSING; MD9: ✅; seq P4-MED |
| 373 | Org Setup Wizard — Step 5: Team Setup |  | Audit #373 (Cat 19); BuildSpec v4.3 §08; MD9 Part V | Apr-26 audit: MISSING; MD9: ✅; seq P4-MED |
| 375 | Org Setup Wizard — Step 7: Email Integration (M365 OAuth2) |  | Audit #375 (Cat 19); BuildSpec v4.3 §08; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P4-MED |
| 376 | Org Setup Wizard — Step 8: Review & Launch (confetti) |  | Audit #376 (Cat 19); BuildSpec v4.3 §08; MD9 Part V | Apr-26 audit: MISSING; MD9: ✅; seq P4-MED |
| 377 | Accountant Onboarding — Step 1: Profile | MD9 note: keep rev-rec; chargeback-rules training obsolete | Audit #377 (Cat 19); BuildSpec v4.3 §08; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P4-MED |
| 378 | Accountant Onboarding — Step 2: Rev Rec setup per company | MD9 note: keep rev-rec; chargeback-rules training obsolete | Audit #378 (Cat 19); BuildSpec v4.3 §08; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P4-MED |
| 379 | Accountant Onboarding — Step 3: GL Classification & Chargeback rules training | MD9 note: keep rev-rec; chargeback-rules training obsolete | Audit #379 (Cat 19); BuildSpec v4.3 §08; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P4-MED |
| 380 | Accountant Onboarding — Step 4: Platform Tour | MD9 note: keep rev-rec; chargeback-rules training obsolete | Audit #380 (Cat 19); BuildSpec v4.3 §08; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P4-MED |
| 381 | Accountant Onboarding — Step 5: Preferences & Go | MD9 note: keep rev-rec; chargeback-rules training obsolete | Audit #381 (Cat 19); BuildSpec v4.3 §08; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P4-MED |
| 382 | Department Setup Wizard — AI config from plain English description | MD9 note: wanted — full spec II.7 Step 4 | Audit #382 (Cat 19); BuildSpec v4.3 §08; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P4-MED |
| S-1175 | Org wizard Step 1 details: name, primary contact, email, timezone (America/Chicago default), fiscal year start month | Triggered on first admin login when setup_complete=false; ~15 min | BuildSpec v4.3 §08 |  |
| S-1176 | Org wizard Step 3 company fields: name, short code, industry, FY start, GL classification default, revenue recognition method |  | BuildSpec v4.3 §08 |  |
| S-1177 | Org wizard Step 7: connect M365 inboxes via Azure OAuth2; payables inbox and receipts inbox configured per company |  | BuildSpec v4.3 §08 |  |
| S-1178 | Accountant onboarding Step 2 detail: rev-rec method per assigned company with conditional branching; which jobs need rev rec; system-calculated vs user-provided data; correction approach (true-up forward vs retroactive) |  | BuildSpec v4.3 §08 |  |
| S-1179 | Accountant onboarding Step 1 profile: name, initials, theme preference, default company, notification prefs |  | BuildSpec v4.3 §08 |  |
| S-1180 | Production deploy & data migration: import history from QBO/Sage; parallel-run validation |  | BuildSpec v4.3 §27 #10 | MEDIUM |
| S-1181 | Onboarding Step 0 — AI onboarding interview ("Tell me about your business") producing editable proposed setup plan (companies, departments, charge method, COA source, conversion approach, roles); skippable |  | MD9 II.7 Step 0 |  |
| S-1182 | Onboarding layout: step rail + persistent AI copilot pane aware of step & entered data; six AI roles (Interviewer, Extractor, Mapper, Recommender, Validator, Explainer) |  | MD9 II.7 B |  |
| S-1183 | Onboarding is resumable and collaborative: per-step save, steps assignable to different users (admin structure, CFO policy/opening balances, accountant COA mapping), per-step status; idempotent/re-openable before go-live |  | MD9 II.7 A, D |  |
| S-1184 | Step 1 Org profile: name, legal name, address, EIN, base currency, FY start, cash/accrual default; AI enrichment from domain/EIN |  | MD9 II.7 Step 1 |  |
| S-1185 | Step 2 Companies: name, short code, industry, FY, base currency, basis, default charge method; AI extracts list from org chart/prior export, classifies industry, flags holding/overhead companies |  | MD9 II.7 Step 2 |  |
| S-1186 | Step 3 Departments per company from plain-English description with hierarchy and per-dept charge-method recommendation; zero-department company allowed |  | MD9 II.7 Step 3 |  |
| S-1187 | Step 4 COA source choice: standard / bring-your-own (QBO/Sage/Excel import used as-is) / hybrid merge table (their account / suggested match / confidence / keep/map/add); new accounts via approval workflow |  | MD9 II.7 Step 4 |  |
| S-1188 | Step 5 Opening balances / conversion: pick go-live date; upload prior TB (+ open AR, open AP, bank statements, FA register, loan schedules, equity); AI maps lines, proposes opening JE with live balanced indicator and explains imbalance cause; open AR/AP as individual documents so aging is right day one; FA with accum dep and remaining life; loans with amortization; equity by holder | Opening TB must balance (override w/ reason); AR/AP detail ties to control; CFO/controller sign-off | MD9 II.7 Step 5 | Critical |
| S-1189 | Step 6 Bank & card connections via Plaid per company; map to GL cash/credit + company/department; feed start = conversion date; AI recommends GL mapping and reconciles opening balance vs conversion balance (uncleared items) | User authenticates, never AI | MD9 II.7 Step 6 |  |
| S-1190 | Step 7 Email ingestion: connect AP/receipt mailbox via OAuth, choose folders/addresses, preview routing; AI runs sample extraction on a recent invoice into a proposed bill |  | MD9 II.7 Step 7 |  |
| S-1191 | Step 8 Vendors & customers import with AI dedup (confidence), per-vendor default GL/job, 1099 flag, compliance status; flags missing W-9/COI and queues auto-chase; customer open balances tie to AR control |  | MD9 II.7 Step 8 |  |
| S-1192 | Step 9 Accounting policies per company: rev-rec method, capitalization threshold, amortization defaults, deferred revenue handling, AI auto-post thresholds (default OFF), close calendar (day 3/7/10), receipt-chase config, bank-match thresholds; AI recommends by industry |  | MD9 II.7 Step 9 |  |
| S-1193 | Step 10 Team & roles: invite by email, assign role, per-company/department access; AI suggests role from title and flags separation-of-duties conflicts (preparer+approver+check printer) |  | MD9 II.7 Step 10 |  |
| S-1194 | Step 11 Readiness checklist with jump-to-fix; AI summary of opening position; launch opens first period, starts feeds, lands on dashboard with real opening position; hard gates: balanced TB, ≥1 admin, COA active |  | MD9 II.7 Step 11 |  |
| S-1195 | Onboarding warms vendor-pattern cache from imported transaction history (cold-start fix) |  | MD9 II.7 C.1 |  |
| S-1196 | Pre-go-live automation dry run: run pipeline on sample email invoice + bank lines to show categorization/confidence and tune thresholds |  | MD9 II.7 C.1 |  |
| S-1197 | Conversion date = automation boundary: feeds and email start at conversion date to prevent double counting |  | MD9 II.7 C.1 |  |
| S-1198 | Post-go-live "add a company" runs abbreviated Steps 2–10 plus a per-entity conversion |  | MD9 II.7 D |  |
| S-1199 | Per-module onboarding status tracked per (organization × module) with designated onboarding rep; shared core masters imported once; import dependency order enforced |  | Suite Architecture §3 |  |
| S-1200 | Onboarding reframed as Merit Suite onboarding provisioning Books as first module; customers/vendors/items/entities imported to Core with canonical UUIDs |  | Suite Architecture §5 |  |
| S-1201 | Tabula rasa: system starts blank, no demo data or hardcoded entity counts/"Portfolio Companies" labels | Mike's directive | Handoff S10 §3, §7 | Rule |
| S-1202 | Historical data import from QuickBooks via QBO OAuth2 |  | Handoff S10 §4 | P1 (S10) |
| S-1203 | 12-step onboarding wizard | — | [H] D40 Part II.7; S47 (mig 106 / 107) | Built |
| S-1204 | Chart of accounts source choice | Standard / bring your own / hybrid | [H] D40 Part II.7 | Canon |
| S-1205 | Historical conversion | One-time import from QBO / Sage / Xero / spreadsheet → AI categorizes → proposed opening TB → human ties out before go-live. A4. | [H] D40 Part II.7; S44; [D1] CATv1 A4; FIRM A4/B10 | Built; 3.15; partial; Gate 11a |
| S-1206 | QBO/Sage are one-time imports only | — | [H] ANCHOR §1; S43 | Canon |
| S-1207 | Direct-API connectors | QBO / Xero / Sage | [H] S50 | MOCK; needs OAuth |
| S-1208 | Per-module onboarding; new-tenant runbook | — | [H] D10 | Canon |
| S-1209 | Onboarding conveniences | Skippable ERP step, pins company, readiness checklist | [H] S48; S49 | Built |
| S-1210 | AI never enters credentials; blank slate | — | [H] D40 Part I, II.7 | Canon |
| S-1211 | CSV migration import | Master data → `core`, ledger data → `public`. TB must balance; grouped GL history balanced per entry. AI maps columns via aliases. | [D1] INT §1e, §2.7 | built (`/import`) |
| S-1212 | Direct-API QBO / Sage / Xero import | Via Codat aggregator | [D1] INT §2.7; ERP §2F | none |
| S-1213 | Bulk AI categorization of historical transactions → standard COA | NEW-ON1 | [D1] CATv2 §6.3; [D2] FTP §8 M2 | none; Top30 #28; NONE ⭐NEW; onboarding top-3 (a) |
| S-1214 | Opening-TB tie-out gate | Debits = credits; subledger → control. NEW-ON2. | [D1] CATv2 §6.3 | none |
| S-1215 | COA remap from prior system | AI maps by role. NEW-ON3. | [D1] CATv2 §6.3; INT §2.7 | none |
| S-1216 | Conversion-quality anomaly detection | Gaps, duplicates, orphans. NEW-ON4. | [D1] CATv2 §6.3; [D2] FTP §8 M4 | none; NONE ⭐NEW |
| S-1217 | Cleanup-effort / onboarding-load estimate | NEW-ON5 | [D1] CATv2 §6.3; [D2] FTP §8 M5 | none; NONE ⭐NEW |
| S-1218 | "Connect your existing system" onboarding step | "How do you run jobs today?" → pick from catalog → branch: OAuth / aggregator link with preview and field-mapping confirm; CSV uploader with per-system template; manual template; or Merit Projects fallback | [D1] ERP §0, §3.3 | spec (task #139) |
| S-1219 | Gated onboarding playbook | Access collected → import → opening TB tied out → COA mapped → first clean close | [D1] FIRM A4/B10 | — |
| S-1220 | Rev-rec method capture for all 9 methods during onboarding | — | [D1] COV #23 | built |
| S-1221 | Portfolio onboarding | Listed as an area where MeritBooks is ahead | [D1] GAP §5 | built |
| S-1222 | Import pipeline + setup wizard | CSV; master → core, ledger → public; header-alias auto-map; TB / open AR / open AP / GL-history importers; per-company posting | [D2] FTP §8 | BUILT |
| S-1223 | Prior-system export extraction + scanned-doc OCR | QBO/Sage/Xero/spreadsheets; scanned statements/prior returns | [D2] FTP §8 M1 | partial ⭐NEW |
| S-1224 | Opening-TB tie-out gate + dedupe of imported master data | Nothing posts until human blesses the opening position | [D2] FTP §8 M3/M10 | partial ⭐NEW; top-3 (b) |
| S-1225 | Draft opening-balance JE, COA crosswalk, conversion summary / first-close checklist | Drafting | [D2] FTP §8 M6 | NONE ⭐NEW |
| S-1226 | Conversion-delta explanation for client sign-off | Narrative | [D2] FTP §8 M7 | NONE ⭐NEW |
| S-1227 | NL conversion | "Import my QBO export"; "did opening balances tie?" | [D2] FTP §8 M8 | → nl-copilot |
| S-1228 | Conversion playbook orchestration | Access → import → map → tie-out → cleanup → first clean close | [D2] FTP §8 M9 | partial ⭐NEW; top-3 (c) |
| S-1229 | COA-mapping target + convert-vs-summarize recommendations | Recommendations | [D2] FTP §8 M11 | NONE ⭐NEW |
| S-1230 | Conversion-progress alerting | Alerts | [D2] FTP §8 M12 | NONE ⭐NEW |
| S-1231 | Prior-system mapping knowledge + learned crosswalk memory | QBO/Sage conventions → roles | [D2] FTP §8 M13/M14 | NONE ⭐NEW |

## Integrations

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| S-1232 | Operational ERP job sync into correct department: BuilderTrend, RFMS, Simpro, ServiceTitan, FieldEdge, Innergy, Jobber | Open: job→department mapping, auto-init rev-rec on job creation | MD9 IX, X.1 | OPEN |
| S-1233 | QBO / Sage Intacct as one-time migration import sources only (AI-assisted mapping of COA/vendors/jobs) |  | MD9 IX, VI |  |
| S-1234 | Core provider connection registry (capability AR_COLLECTION / AP_DISBURSEMENT / PAYROLL / BANK_FEED, test/live env) with secrets in vault; Core verify-and-route receiver for provider webhooks | Webhook receiver not yet built per MD9 | Suite Architecture §3B | Registry BUILT |
| S-1235 | ERP job sync fields external_project_id / external_source; ERP = source of truth for job identity/scope/dates, MeritBooks for financials | Connectors future (P2) | Handoff S8 §2, §4 | P2 |
| S-1236 | Operational ERP job sync | BuilderTrend, RFMS, Simpro, ServiceTitan, FieldEdge, Innergy, Jobber | [H] D40 Part IX; S47 (mig 108 / 109) | Framework built |
| S-1237 | ERP job → department mapping | — | [H] D40 Part X | Open decision |
| S-1238 | Integration map | ~30 systems | [H] S43 | Governance |
| S-1239 | Provider connections + webhook routing | — | [H] D10 | Built (mig 041) |
| S-1240 | Projects module integration | — | [H] D10 | Built |
| S-1241 | Optional Sentry | — | [H] S50 | Built |
| S-1242 | Ramp two-way accounting connection | Developer-API connection (OAuth). Push GL accounts, Department/Class/Location, vendors, entities with per-entity valid codes. Pull `*.ready_to_sync` via HMAC webhooks plus polling. Post JEs; acknowledge via `POST /accounting/syncs` with fix-it messages. All ~15 entities in one Ramp Plus business. | [D1] GAP §2, §3A #1 | T1 Now; missing |
| S-1243 | Ramp-vs-GL completeness detector and Ramp payment pairing | Ramp statement payments paired to posted entries, no double-count | [D1] GAP §2 | T1 |
| S-1244 | Brex / Expensify spend and receipt feed | Dedup vs bank feed; policy flags; AI compares the spend tool's coding to its own | [D1] INT §2.2 | none |
| S-1245 | Direct bank / BAI2 prior-day file | SFTP; duplicate-file detection; balance tie-out | [D1] INT §2.1 | none |
| S-1246 | Corporate-card issuer feed (direct) | — | [D1] INT §2.2 | partial |
| S-1247 | Lockbox remittance feed (SFTP) | — | [D1] INT §2.1, §4 #6 | none |
| S-1248 | Payroll register via Finch (unified payroll/HRIS) | Gusto, ADP, Paychex, Rippling, etc. | [D1] ERP §2G, §3.2 | recommended T2 |
| S-1249 | Benefits / carrier deductions feed | Ties deduction totals to remittance | [D1] INT §2.3 | none |
| S-1250 | Sales-tax engine (Avalara / TaxJar) | Fallback table plus flag when the service is down | [D1] INT §2.4, §4 #5 | none |
| S-1251 | Income-tax provision handoff export | Adjusted TB, book-tax differences, M-1 schedule | [D1] INT §2.4 | none |
| S-1252 | Secretary of State / registered-agent feed | — | [D1] INT §2.4 | none |
| S-1253 | Microsoft 365 Graph email-to-bill ingestion | Second `EmailProvider` (`ms_graph`) | [D1] INT §2.5, §4 #1 | spec; blocked (Gate 4, Azure creds since Session 22) |
| S-1254 | Azure Document Intelligence OCR | Low-confidence results to human review; reconciled against the LLM extraction | [D1] INT §2.5 | spec; blocked |
| S-1255 | LLM-vision bill/receipt parse (interim OCR) | `bill-parser.ts`, ≤10MB | [D1] INT §2.5 | built (bypasses gateway) |
| S-1256 | DocuSign / e-sign | W-9s, vendor agreements, engagement letters; AI pre-fills W-9 | [D1] INT §2.6 | none |
| S-1257 | Box / Google Drive / SharePoint document storage | Link stored on the transaction; missing-doc detection | [D1] INT §2.6 | none |
| S-1258 | CRM sync (Salesforce / HubSpot) | Customer master; AR status back to CRM; AI dedupe | [D1] INT §2.8 | none |
| S-1259 | Procurement / PO system feed | For 3-way match | [D1] INT §2.8 | none (Gate 11b) |
| S-1260 | BI / warehouse export (Snowflake / BigQuery / API) | Control-total reconciliation; AI semantic layer / NL-to-query | [D1] INT §2.8 | none |
| S-1261 | Ledger formulas in Excel / Google Sheets | — | [D1] GAP §3D #29 | T3; missing |
| S-1262 | Suite event bus (`core.events`, FROZEN v3) | JOB_COST (Books → Projects); JOB_BILLING + JOB_PROGRESS (Projects → Books); unique (org_id, event_id); worker read-scoping still open | [D1] INT §1d, §2.8 | built |
| S-1263 | Resend transactional email | Throws on failure; needs key rotation and `INVOICE_FROM_EMAIL` | [D1] INT §2.9 | built |
| S-1264 | SMS provider (Twilio class) | Settings UI shows SMS preferences with no provider wired | [D1] INT §2.9, F3 | none |
| S-1265 | Money-movement capability-adapter boundary | AR_COLLECTION / AP_DISBURSEMENT / PAYROLL / BANK_FEED; selected per tenant from `core.provider_connections`; entitlement-gated | [D1] INT §1a | built (framework) |
| S-1266 | ERP connector framework (ERP_INGEST) | Methods: NATIVE_API / AGGREGATOR / WEBHOOK / CSV_IMPORT / MANUAL. One canonical intake queue with entity resolution and `score-tier` confidence; field-mapping review UI; idempotent unique (org_id, connector_key, external_id); read-only, never writes back. | [D1] ERP §3.1–3.2 | spec (task #139) |
| S-1267 | ServiceTitan native connector | Accounting API: invoices, payments, inventory bills, payroll export. Matches HVAC portfolio companies. | [D1] ERP §2A, §4 Tier 1 #1; GAP #24 | Tier 1 #1; none |
| S-1268 | Jobber native connector | GraphQL, OAuth2, HMAC webhooks | [D1] ERP §2F, §4 Tier 1 #2 | Tier 1 #2 |
| S-1269 | JobNimbus native connector (roofing) | — | [D1] ERP §2C, §4 Tier 1 #3 | Tier 1 #3 |
| S-1270 | Procore native connector (GC financials) | Budgets, commitments, requisitions, change orders | [D1] ERP §2B, §4 Tier 1 #4 | Tier 1 #4 |
| S-1271 | RFMS native connector (flooring) | — | [D1] ERP §2D, §4 Tier 1 #5 | Tier 1 #5 |
| S-1272 | Fast-follow native connectors | JobTread, Housecall Pro, Knowify, AccuLynx, ServiceTrade, Innergy (partner API) | [D1] ERP §4 Tier 1 #6 | Tier 1 fast-follow |
| S-1273 | Other catalogued field/construction systems | FieldEdge, Service Fusion, Workiz, BuildOps, Aspire, mHelpDesk, Kickserv, CoConstruct, Buildxact, Roofr, Leap, MarketSharp, Dataforma, QFloors, Pacific Solutions, Sage Intacct / 300 CRE / 100 Contractor, Foundation, Viewpoint Vista/Spectrum, CMiC, Acumatica, NetSuite | [D1] ERP §2A–2E | catalog |
| S-1274 | Codat aggregator (primary) | Accounting migration sources plus construction-adjacent systems; retires the Flow-B long tail | [D1] ERP §2G, §4 Tier 2 | Tier 2 |
| S-1275 | Merge / Rutter / Apideck aggregators (alternates) | — | [D1] ERP §2G | Tier 2 alt |
| S-1276 | CSV/manual Tier-3 templates | Buildertrend, Contractor Foreman, Houzz Pro, Sage 300 CRE / 100, Foundation, Comp-U-Floor / RollMaster, Measure Square, Cabinet Vision, Microvellum, Mozaik, Allmoxy (BOM/estimate feeds) | [D1] ERP §4 Tier 3 | Tier 3 |
| S-1277 | ClickUp / Monday.com project-dimension feed | Not AR/AP sources | [D1] ERP §2F | — |
| S-1278 | Alerts delivered to Slack / Teams | — | [D1] GAP §3A #3 | T1 |
| S-1279 | Projects module seam | `JOB_COST` / `JOB_BILLING` / `JOB_PROGRESS` events (FROZEN v3); `proj.commitments` | [D2] AP intro/D1; AR A5; FTP §6 | Seam exists |
| S-1280 | Licensed tax providers | Avalara/TaxJar/Vertex/Stripe Tax (+CertCapture); Track1099/Tax1099/Sovos; IRS TIN Matching; CCH/Lacerte/UltraTax handoff; CSC/CT/Harbor | [D2] TAX Part 2 provider notes | Provider-gated; none built |
| S-1281 | Payroll provider (Check vs Gusto) | Phase B webhooks | [D2] FTP §4 | Owner decision pending |
| S-1282 | Resend delivery/bounce webhook; Stripe refunds / auto-charge; D&B/Experian bureau | Integration | [D2] AR B9/C17/C18/C30 | missing; bureau deferred |
| S-1283 | Bank files | Lockbox/BAI2 inbound; positive-pay outbound; EDI 810 / vendor portals | [D2] AR C23; AP F4/A4 | GAP |
| S-1284 | External data seams | Pipeline/bookings/subscription, payroll/HR roster, benchmark dataset, comp benchmarks (RCReports) | [D2] FPA B5/C1/G5; TAX E4 | none |

## Portals (client, vendor, customer)

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 325 | Client portal (branded, secure document/report sharing) |  | Audit #325 (Cat 16); BuildSpec v4.3 §04 Practice, §26; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌/🔶; seq P6-FUTURE |
| S-1285 | Online customer payment portal (view + pay invoices) | "Planned for later phase" | BuildSpec v4.3 §21 | Later phase |
| S-1286 | Customer portal | Invoices, balance, statement, pay | [H] S50 (mig 141) | Built |
| S-1287 | Vendor portal | Uploads land PENDING | [H] S50 (mig 142) | Built |
| S-1288 | External auditor access + PBC list | — | [H] S50 (mig 145) | Built |
| S-1289 | Hosted pay page + tokenized PDF | — | [H] S38 | Built |
| S-1290 | Client portal (firm clients) | Document upload, open-question answers, deliverable review/approval, status, escalating reminders; uncertain categorizations become portal questions. G4. | [D1] CATv1 G4; FIRM A5/B5/C4 | 3.30; none |
| S-1291 | Per-client open-questions and document-request lists | — | [D1] FIRM A5 | — |
| S-1292 | Self-serve customer AR portal | Pay one or many invoices, dispute, history. AR-B11. | [D1] CATv2 AR-B11; [D2] AR Group B | High 3.25; none; MISSING; AR Tier 4 #10 |
| S-1293 | Hosted Pay Now page | See AR-C32 | [D1] CATv2 AR-C32 | built |
| S-1294 | Hosted single-invoice pay page | `/pay/[token]`; VIEWED tracking; full-balance only (no partial) | [D2] AR B8/C24/C32 | BUILT |
| S-1295 | Client portal document upload IDP (practice) | Client-uploaded statements/receipts | [D2] FTP §5 M1 | NONE ⭐NEW |

## Admin / RBAC / identity / security

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 51 | Separation of duties (preparer ≠ approver ≠ check printer) | Preparer ≠ approver ≠ check printer. MD9 note: RBAC roles exist — wire it | Audit #51 (Cat 2); BuildSpec v4.3 §04 AP; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P2-HIGH |
| 344 | User Management — table with role, companies, last active, invite button | MD9 note: Team page; remove labor-type/utilization | Audit #344 (Cat 17); BuildSpec v4.3 §24, §08; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶 |
| 345 | User Management — Invite User functionality | MD9 note: Clerk invites pending sign-off | Audit #345 (Cat 17); BuildSpec v4.3 §24, §08; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌ |
| 346 | User Management — Dynamic sidebar per role | MD9 note: RBAC built; nav not enforced | Audit #346 (Cat 17); BuildSpec v4.3 §24, §08; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶 |
| 351 | Settings — Organization (name, contact, email) |  | Audit #351 (Cat 17); BuildSpec v4.3 §24, §08; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶 |
| 352 | Settings — Integrations (M365, Plaid status per company) | MD9 note: status only | Audit #352 (Cat 17); BuildSpec v4.3 §24, §08; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶 |
| 355 | Settings — Portfolio Companies management with Add Company modal | MD9 note: extend with departments + method | Audit #355 (Cat 17); BuildSpec v4.3 §24, §08; MD9 Part V | Apr-26 audit: MISSING; MD9: 🔶 |
| 401 | Clerk SSO with multi-tenant orgs | MD9 note: middleware.ts | Audit #401 (Cat 21); BuildSpec v4.3 §16–17; MD9 Part V | Apr-26 audit: BUILT; MD9: ✅; seq P4-MED |
| 402 | JWT with org/role claims + JWKS validation | MD9 note: verify | Audit #402 (Cat 21); BuildSpec v4.3 §16–17; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶; seq P4-MED |
| 403 | MFA enforced for Admin and CFO roles | MFA for Admin and CFO | Audit #403 (Cat 21); BuildSpec v4.3 §16–17; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P4-MED |
| 404 | 7 web roles (Org Admin, CFO, Acct Mgr, Sr Accountant, Accountant, Check Processor, Viewer) | MD9 note: RBAC built S11; nav enforcement pending | Audit #404 (Cat 21); BuildSpec v4.3 §16–17; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶; seq P4-MED |
| 406 | Screen-level permissions per role | MD9 note: wire RBAC to nav/pages | Audit #406 (Cat 21); BuildSpec v4.3 §16–17; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P4-MED |
| 407 | PostgreSQL RLS on every table | MD9 note: all migrations | Audit #407 (Cat 21); BuildSpec v4.3 §16–17; MD9 Part V | Apr-26 audit: BUILT; MD9: ✅; seq P4-MED |
| 408 | AES-256-GCM encryption for integration credentials |  | Audit #408 (Cat 21); BuildSpec v4.3 §16–17; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P4-MED |
| 409 | Session management (30-min idle, 12-hr absolute, 5 concurrent max) | 30-min idle, 12-hr absolute, 5 concurrent | Audit #409 (Cat 21); BuildSpec v4.3 §16–17; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P4-MED |
| 410 | IP allowlisting by CIDR for admin roles |  | Audit #410 (Cat 21); BuildSpec v4.3 §16–17; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P4-MED |
| 411 | Account lockout after 5 failed attempts |  | Audit #411 (Cat 21); BuildSpec v4.3 §16–17; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P4-MED |
| 412 | Device fingerprinting |  | Audit #412 (Cat 21); BuildSpec v4.3 §16–17; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P4-MED |
| 413 | Soft deletes for financial data | MD9 note: inconsistent | Audit #413 (Cat 21); BuildSpec v4.3 §16–17; MD9 Part V | Apr-26 audit: PARTIAL; MD9: 🔶; seq P4-MED |
| 414 | AI audit trail (model version, prompt, output, confidence, human response) | MD9 note: ai_audit_log | Audit #414 (Cat 21); BuildSpec v4.3 §16–17; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ⬜; seq P4-MED |
| 415 | Data export tracking (user, timestamp, scope, format) |  | Audit #415 (Cat 21); BuildSpec v4.3 §16–17; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P4-MED |
| S-1296 | Session security: device fingerprinting, 30-min idle, 12-hr absolute, 5 concurrent sessions, admin IP allowlist (CIDR), lockout after 5 failed attempts |  | BuildSpec v4.3 §16 |  |
| S-1297 | Credential encryption AES-256-GCM, unique DEK per credential, KMS-backed with automatic rotation |  | BuildSpec v4.3 §16 |  |
| S-1298 | Encrypted file storage with access logging; files attached to GL entries during approval |  | BuildSpec v4.3 §16 |  |
| S-1299 | Data-level filtering by company assignment; sidebar shows only permitted screens |  | BuildSpec v4.3 §16–17 |  |
| S-1300 | Org Admin powers: maintenance mode, user mgmt, all overrides, feature-flag management; MFA required for Org Admin and CFO |  | BuildSpec v4.3 §17 |  |
| S-1301 | CFO role: cash, forecasting, compliance, budgets; cross-entity visibility; no transaction processing |  | BuildSpec v4.3 §17 |  |
| S-1302 | Accounting Manager role (player-coach): processing + team + time review; override holds, approve COA, manage close gates, configure receipt chase |  | BuildSpec v4.3 §17 |  |
| S-1303 | Senior Accountant: cross-company processing incl. intercompany; Accountant: assigned companies only; Viewer read-only |  | BuildSpec v4.3 §17 |  |
| S-1304 | Add Company modal: name, code, industry, rev rec method, GL classification default, assigned accountant |  | BuildSpec v4.3 §24 |  |
| S-1305 | Setup creator auto-becomes org_admin |  | MD9 II.3, IV.3 | BUILT |
| S-1306 | 9 roles: Company Admin, CFO, Merit Controller, Assistant CFO, Accounting Manager, Accounting Specialist, Check Processor, General Admin/Data Entry, Business User (external); 36 features with action-level permissions; per-company access (employee_locations) and role overrides | CFO controls accounting settings but not system/user settings | MD9 IV.3 | Built S11; nav enforcement pending then |
| S-1307 | Business Users (external) see only their own company |  | MD9 IV.3 |  |
| S-1308 | 11e General approval-workflow engine: configurable multi-step routing on bills, POs, JEs, expenses; delegation; limits |  | MD9 GATE 11e | OPEN |
| S-1309 | Audit & compliance scaffolding: immutable audit trail, access logs, SoD enforcement, SOX-style controls | PE exit-readiness = product | Posting Engine Spec Part I #9 | BUILD |
| S-1310 | Configurable industry segments (by accounting manager), not hardcoded |  | Handoff S10 §3 |  |
| S-1311 | RBAC sidebar: admin sees everything, accountant sees transaction pages + reports, viewer sees reports only | Mike: "Not all users will be accounting users" | Handoff S10 §1, §6 |  |
| S-1312 | Mike is platform admin | Adds and manages tenants | [H] OD | Owner directive |
| S-1313 | Required role list | Owner, CFO, controller, FD, acct mgr, bookkeeper, HR/payroll, ops leader, other | [H] OD | Owner directive |
| S-1314 | Build-spec roles | 7 web + 3 mobile; 36 features × 9 roles | [H] D20; D40 Part IV | Built |
| S-1315 | Identity model | System / Org Admin / Accounting / Business user | [H] D10 FILE 4 | Canon |
| S-1316 | Access = entitlements ∩ role | Database enforces membership | [H] D10 FILE 4 | Canon |
| S-1317 | Team & Access | Invite, deactivate, lifecycle sync | [H] S39; S41 | Built |
| S-1318 | Multi-tenant org resolution | — | [H] S42; S45; [D1] COV #24/#26; CATv2 §4 #2 | CLOSED live; Crit; open NO-GO gate #9; Top30 #2 |
| S-1319 | Permission checks on money routes and sensitive pages | — | [H] S41; S42 | Built |
| S-1320 | Custom roles + plain-English role explanations | — | [H] S48 (mig 130) | Built |
| S-1321 | Sidebar filtered by role | Custom roles currently see all links | [H] S50; D40 GATE 10 | Built (UX follow-up) |
| S-1322 | Approval workflows | N-step by document type + amount tier; simulator; coverage gaps | [H] S45 (mig 092); S49 | Built; per-entity needs schema |
| S-1323 | Location-scoped RLS | Per-client fiduciary isolation | [H] S39–S50 | Open |
| S-1324 | Event-worker auth + read scoping | — | [H] S42 | Auth built; read scoping open |
| S-1325 | Control and team_performance permissions | — | [H] S42–S50 | Open |
| S-1326 | Audit trail | — | [H] S39 (mig 062 / 063); S49 | Built |
| S-1327 | Security hardening items | — | [H] S38; S48; S50 | Built |
| S-1328 | Error observability | — | [H] S50 (mig 146) | Built |
| S-1329 | Clerk prod cutover + `app.` subdomain | — | [H] S45; S47; ANCHOR §6 | Open (human) |
| S-1330 | Event-worker secret + Resend key rotation | — | [H] S42–S50 | Open (human) |
| S-1331 | Control-route RBAC, location-scoped RLS and a dedicated `payments` permission | Task #33 | [D1] COV #24/#26 | open |
| S-1332 | `canApprove` reconciled to `core.memberships` / roles | Not `core.employees.role` | [D1] MGR B6; CFO Part 3; CPA B8; CATv1 H3 | partial |
| S-1333 | Immutable audit trail with machine-vs-human attribution | Append-only `action_log` / `audit_log`; actor is a named human or AI + version; before/after; reason / support link; approval chain; period-lock and reopen trail. PW3 / H3. | [D1] CATv2 PW3; CATv1 H3; MGR B2/B7 | Crit 4.20; partial |
| S-1334 | SoD enforcement including the AI | Preparer ≠ approver ≠ releaser via DB CHECK + service; nobody both creates and pays a vendor; continuous SoD conflict scan; SoD matrix generated from live role data. AP-E2. | [D1] CATv2 AP-E2; MGR A6/B6; CPA B8 | High 3.70; partial |
| S-1335 | Second approval on high-risk master-data changes | E.g. vendor bank account | [D1] MGR A6/B6 | — |
| S-1336 | Approval enforcement on bills, JEs and payments | One materiality policy for people and agents; routing by entry source (agent / API / MCP / UI) | [D1] GAP §3A #4 | T1 Now; partial |
| S-1337 | Approval hierarchy and authority limits per tenant role map | — | [D1] MGR Part C | segment config |
| S-1338 | Autonomy-dial configuration changes are audited | — | [D1] CFO #10 | — |
| S-1339 | MFA / SSO / passkeys | — | [D1] GAP §3D #28 | T3 (before tenant #2); missing |
| S-1340 | Practice identity | One firm user acting across N client tenants with per-tenant RLS; firm vs client roles | [D1] FIRM C6, Part D | spec (Gate 10/11a) |
| S-1341 | Secret placement | Per-tenant secrets in Supabase Vault (`secret_ref`); platform keys in Vercel env; secret values never returned | [D1] INT §1b | built |
| S-1342 | Entitlement gating of capabilities | `core.organizations.entitlements` | [D1] INT §1a | built |
| S-1343 | Segment configuration rule packs | Materiality, COA rules, rev-rec method, close workstreams, consolidation cells, regulatory overlays as config, not forks | [D1] MGR Part C; CFO appendix | principle |
| S-1344 | Multi-tenant org resolution + `canApprove` reconciled to `core.memberships` | Identity gate #9; control-route RBAC | [D2] AP E2; BC E8; GLC J4; TAX F4 | OPEN (NO-GO gate) |
| S-1345 | RBAC + SoD on AR actions | `invoices:create`; elevated role for credit memo/void/write-off/refund; collector ≠ write-off approver (AR C36) | [D2] AR Group G; P2P S4 M10 | PARTIAL; AR Tier 5 #12 |
| S-1346 | RBAC + SoD on customer credit-limit / terms changes | Elevated role | [D2] P2P S6 M10 | partial |
| S-1347 | Continuous SoD-conflict scanning + SoD control-matrix report | Same person creates vendor and pays it; approves and posts (AP E2, TAX F4) | [D2] AP Group E; TAX Group F | PARTIAL; AP #7 |
| S-1348 | PO approval SoD (requisitioner ≠ approver ≠ receiver) | SoD | [D2] P2P S9 M10 | partial |

## Mobile / workforce app

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 392 | Receipt Capture — Overdue receipt chase cards | MD9 note: IN scope — feeds pipeline | Audit #392 (Cat 20); BuildSpec v4.3 §15; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 393 | Receipt Capture — Camera with alignment frame | MD9 note: IN scope — feeds pipeline | Audit #393 (Cat 20); BuildSpec v4.3 §15; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 394 | Receipt Capture — AI processing animation | MD9 note: IN scope — feeds pipeline | Audit #394 (Cat 20); BuildSpec v4.3 §15; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 395 | Receipt Capture — Pre-populated confirm screen (vendor, amount, date) | MD9 note: IN scope — feeds pipeline | Audit #395 (Cat 20); BuildSpec v4.3 §15; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 396 | Receipt Capture — 6 purchase type options (Materials, Tools, Gas, Meals, Office, Not sure) | MD9 note: IN scope — feeds pipeline | Audit #396 (Cat 20); BuildSpec v4.3 §15; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 397 | Receipt Capture — Card match notice | MD9 note: IN scope — feeds pipeline | Audit #397 (Cat 20); BuildSpec v4.3 §15; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 398 | Receipt Capture — Push notification ("Missing receipt: Shell Gas $68.42...") | MD9 note: IN scope — feeds pipeline | Audit #398 (Cat 20); BuildSpec v4.3 §15; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 400 | Mobile Activity Feed | MD9 note: future | Audit #400 (Cat 20); BuildSpec v4.3 §15; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| S-1349 | Department setup wizard output: hierarchy depth 1–3, clock mode (timer vs manual), GPS requirement, GL classification rules, billable flags, PM tool integration (ClickUp, Monday, Asana, Jira, Harvest) | Field flow entity→job→phase with live timer+GPS; office flow task-first with manual hours, no GPS. Config lock web vs mobile | BuildSpec v4.3 §08, §15 | SUPERSEDED (time tracking moved to PM module, Master Doc I.3) |
| S-1350 | Mobile users never see accounting data; React Native or PWA on shared API; 25 screens (time clock 12, receipt 9, dept setup 4) |  | BuildSpec v4.3 §15 |  |
| S-1351 | Quick-tag sets per department: Production 12, HVAC 9, Marketing 11, Accounting 10, IT 9, Admin 8 |  | BuildSpec v4.3 §15 | SUPERSEDED (time → PM module) |
| S-1352 | Mobile app | 3 mobile roles; audit category 20 | [H] D20; D30 | No build status |
| S-1353 | Mobile time clock / GPS | — | [H] D40 Part VI | RETIRED |
| S-1354 | Mobile receipt capture and SMS receipt chase | Field staff photograph, email or text receipts and bill photos from job sites | [D1] GAP #31; BKP Part 1; CATv1 A3 | T3; missing |
| S-1355 | Job-site phone-photo invoice capture | Named only as an intake channel; no mobile app feature specified in these docs | [D2] AP Stage 1 | Not specified |

## Notifications

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| S-1356 | Notifications bell + inbox | — | [H] S47; S49 | Built |
| S-1357 | Push / SMS receipt chase; emailed invoices and statements | — | [H] D40 VIII; S38; S42 | Mixed |
| S-1358 | AI budget warnings | — | [H] D10 | Built (GATE 1) |
| S-1359 | Proactive alerts and one-sentence watch rules | E.g. "tell me when Heartland cash < next payroll"; one-click actions; via email / Slack / Teams | [D1] GAP §3A #3 | T1 Now; missing |
| S-1360 | Model/version-change notifications to supervisors | — | [D1] MGR B9 #8 | — |
| S-1361 | Chase/reminder email send layer | COI/W-9 chases, document chases and dunning all depend on a send layer; COI/W-9 chase sending is blocked on GATE 4 (M365); invoices/reminders send via Resend | [D2] AP B3/I8; AR B8/C13 | Partial |

## Platform, billing & white-label

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 433 | Usage cost per company (AI + infrastructure, feeds billing) | MD9 note: keep (resale billing); **metered by the Core AI gateway across ALL modules, not Books alone** — the tenant cap is enforced on combined suite usage | Audit #433 (Cat 23); BuildSpec v4.3 §25; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| 435 | 3 white-label tiers (Processor, Practice, Complete) |  | Audit #435 (Cat 23); BuildSpec v4.3 §25; MD9 Part V; BuildSpec v4.3 §25 #10 | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE; v3.1 approved (superseded by Marketing pricing tiers) |
| 436 | Module selection config via System Console (AI-powered) |  | Audit #436 (Cat 23); BuildSpec v4.3 §25; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P6-FUTURE |
| S-1362 | Suggest a Feature: categorized by module and type (Enhancement/Bug/New Feature/UI Change), status (Under Review/Deployed), feeds selective rollout via feature flags and targeting rules |  | BuildSpec v4.3 §24 |  |
| S-1363 | Usage cost per company/department (AI + infrastructure) feeding white-label billing |  | BuildSpec v4.3 §25 #8 | v3.1 approved |
| S-1364 | Module selection per customer via System Console with NL configuration |  | BuildSpec v4.3 §25 #11 | v3.1 approved |
| S-1365 | Success metrics instrumented in-product: manual entry reduction 85%+, close in 10 business days, AI accuracy 94%+, cache 80%+, forecast accuracy 95%+, compliance coverage 100%, commercial readiness |  | BuildSpec v4.3 §28 |  |
| S-1366 | Generic multi-tenant platform: nothing tenant-specific hardcoded (no "holding company", "portfolio company", fixed entity list); tenants start blank except per-tenant COA seed | White-label resale goal | MD9 I.2, I.5 | Hard rule |
| S-1367 | Feature depth standard: every module needs a Feature Product Brief (16 dimensions) before build; "complete" = meets FPB; QBO/Sage benchmark; Feature Completeness Ledger | Rules 13–16 | MD9 I.7, V.0 | Governing rule |
| S-1368 | In-app Sandbox seeded test tenant with seed/reset/verify and nine-check cross-module round-trip + 18-check posting verification | Admin nav | MD9 IV.7, GATE 2 | BUILT |
| S-1369 | GATE 10 productization: white-label theming, RBAC sidebar/page enforcement, Clerk invitations, Clerk production instance, MFA/sessions/credential encryption/export tracking |  | MD9 GATE 10 | OPEN |
| S-1370 | Product-tier AI budget dials per tier (tenant monthly cap, soft warn, per-user/per-feature sub-caps, overage policy hard stop vs metered vs upsell) |  | MD9 X.1 | OPEN decision |
| S-1371 | Module entitlements per tenant (core.organizations.entitlements); Books runs standalone (direct entry) or auto-fed by Projects events; never assumes sibling present |  | Suite Architecture §3; Event Contract §10 | Locked |
| S-1372 | Every Books mutation emits an immutable event and is exposed as a typed action; agent layer calls the same actions as the UI |  | Suite Architecture §2.5, §5.5 | Locked |
| S-1373 | Every record navigable (navigability is an explicit completion criterion) |  | Handoff S36 §7 | Standing |
| S-1374 | Generic white-label platform | — | [H] ANCHOR §1; D10 | Canon |
| S-1375 | Suite of 12 modules | Modular monolith with entitlements | [H] D10 FILE 1 | Canon |
| S-1376 | Operator Console | — | [H] S41; S48 | Built |
| S-1377 | Pricing model | $99 / $59 per company, Firm $499 + wholesale | [H] S48 (mig 131) | Built; charging NOT wired |
| S-1378 | White-label theming + tiers | — | [H] D40 GATE 10 / Part X | Open |
| S-1379 | Design system | merit-ui v2.3, designs A/B | [H] CLAUDE.md; OD | Binding; port in progress |
| S-1380 | Copy scrub + help + search palette | — | [H] S47 | Built |
| S-1381 | Marketing honesty | — | [H] S48–S50 | Open |
| S-1382 | Seeded test tenant round-trip | — | [H] D10 FILE 5 | Canon |
| S-1383 | Tenant billing (Stripe) | — | [D1] GAP §3D #27 | T3 (before tenant #2); stub |
| S-1384 | Per-tenant AI cost metering and budget cap | Combined suite tenant budget; over-cap degrade/block | [D1] INT §2.8; MATRIX §5 | built (gateway); route bypass gap |
| S-1385 | Generic white-label, multi-tenant | Merit is just tenant #1; nothing hardcoded | [D1] FIRM Part D; MGR Part C | principle |
| S-1386 | Core AI gateway metering + suite tenant budget | `@meritbooks/core-ai` → `core.ai_usage_log`; all AI routed through it | [D2] AR intro; BC intro | Canon |
| S-1387 | Platform merchant-fee schedules (MeritBooks charges merchant) | See two-layer fee model | [D2] AR C33 | BUILT |

## UI, design system & navigation

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 416 | Dark/Light theme toggle | MD9 note: dark only | Audit #416 (Cat 21); BuildSpec v4.3 §16–17; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P4-MED |
| 417 | Company Switcher (global filter) | Global company filter in header | Audit #417 (Cat 21); BuildSpec v4.3 §16–17; MD9 Part V | Apr-26 audit: MISSING; MD9: ❌; seq P4-MED |
| 418 | Emerald brand (#10b981), Plus Jakarta Sans + JetBrains Mono | MD9 note: globals.css/tailwind.config.ts | Audit #418 (Cat 21); BuildSpec v4.3 §16–17; MD9 Part V | Apr-26 audit: BUILT; MD9: ✅; seq P4-MED |
| S-1388 | World-class UI redesign (Stripe/Linear quality) |  | BuildSpec v4.3 §27 #9 | MEDIUM (brand since replaced by Merit Suite Style Guide v2.3) |
| S-1389 | Detail/navigability layer: every list row clickable into a slide-over detail drawer; hover-peek document previews (mini invoice/bill, JE T-account, receipt image, reference cards); deep-linkable (?invoice=id) |  | MD9 XI.12 | BUILT |
| S-1390 | Proposed vs posted visibly distinct: AI-proposed records carry a provisional chip with confidence % (e.g. "94% · Auto-eligible") until explicit "Approve & post" |  | Platform Design Criteria §4 |  |
| S-1391 | Dimensions shown as compact tags on transactions and as filters on reports |  | Platform Design Criteria §4 |  |
| S-1392 | "In balance" indicator on entries/totals; out-of-balance shows red delta; ledger table pattern with double-rule grand totals, negatives in parentheses, GL code + dimension sub-label | Design system since replaced by Merit Suite Style Guide v2.3 (blue) | Platform Design Criteria §3 |  |
| S-1393 | Honest build-status labels always visible (Live / In sandbox / In development); never imply a module is shipped |  | Platform Design Criteria §3, §6 |  |
| S-1394 | Accessibility bar: WCAG AA contrast, visible focus ring, full keyboard operability, ≥44px targets, reduced-motion respected; every control has hover/active/focus/disabled/loading states |  | Platform Design Criteria §5 |  |
| S-1395 | Empty states: one line describing what appears + one primary action |  | Platform Design Criteria §3 |  |
| S-1396 | Light theme for documents/print surfaces (letterhead, exported statements) |  | Platform Design Criteria §1 |  |
| S-1397 | Global company selector reused across pages; status tabs show "count · $sum"; pagination controls on every list |  | Handoff S8 §5, §7 |  |
| S-1398 | Edit-in-panel: view → Edit toggle; posted records show "override required" banner with mandatory reason; live balance check for JEs |  | Handoff S36 §5 | BUILT |
| S-1399 | Mike's standard: world-class SaaS that beats QuickBooks/Sage on interface and product; benchmark in every FPB |  | Handoff S36 §5 | Standing |

## Other

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| S-1400 | Document center + attachments | — | [H] S45 (mig 090); S49 | Built |
| S-1401 | Inventory | Templates, MVP, valuation; GATE 11c | [H] D20; S47 (mig 101); S49 | Partly built |
| S-1402 | GATE 11e approval-workflow engine | — | [H] D40 Part VII; S45 | Built |
| S-1403 | Feature product briefs required before "Complete" | 16 dimensions + benchmark; Ledger; audit | [H] D30; ANCHOR §4 | Governance; zero modules Complete |
| S-1404 | Field-level spec before building | — | [H] D30 | Canon |
| S-1405 | 461-item feature audit | — | [H] D30; CLAUDE.md | Mandatory |
| S-1406 | Market borrower-side covenant / borrowing-base automation | Differentiator; construction job cost inside a multi-entity AI ledger | [D1] GAP §1 #5, §5 | positioning |
| S-1407 | Gushwork as an optional marketing tool for operating companies | Not a competitor | [D1] GAP §1 #2 | note |

## Retired / superseded — do NOT build

| ID | Feature | Detail / acceptance notes | Source | Priority / status (as stated) |
|---|---|---|---|---|
| 221 | OH Allocation Formula — recalculated monthly from 6000-series OpEx | MD9 note: Replaced by inter-department internal invoices + elimination (II.4). Retire chargebacks page, overhead-rate API/service, chargeback service, cost-allocation, time-review. | Audit #221 (Cat 10); BuildSpec v4.3 §12; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ⛔; seq P3 (now retired) |
| 222 | 5 labor classifications (Overhead/DirectAssigned/Production/OwnerGroup/DealTeam) | MD9 note: Replaced by inter-department internal invoices + elimination (II.4). Retire chargebacks page, overhead-rate API/service, chargeback service, cost-allocation, time-review. | Audit #222 (Cat 10); BuildSpec v4.3 §12; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ⛔; seq P3 (now retired) |
| 223 | Production target: 37.5 hr/wk, <70% utilization for 2 periods = flagged | MD9 note: Replaced by inter-department internal invoices + elimination (II.4). Retire chargebacks page, overhead-rate API/service, chargeback service, cost-allocation, time-review. | Audit #223 (Cat 10); BuildSpec v4.3 §12; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P3 (now retired) |
| 224 | Supervisor gate — production employees only clock to assigned companies | MD9 note: Replaced by inter-department internal invoices + elimination (II.4). Retire chargebacks page, overhead-rate API/service, chargeback service, cost-allocation, time-review. | Audit #224 (Cat 10); BuildSpec v4.3 §12; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P3 (now retired) |
| 225 | Burdened cost formula: Base/12 + 7.65% FICA + 3.50% WC + $680/mo benefits | MD9 note: Replaced by inter-department internal invoices + elimination (II.4). Retire chargebacks page, overhead-rate API/service, chargeback service, cost-allocation, time-review. | Audit #225 (Cat 10); BuildSpec v4.3 §12; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ⛔; seq P3 (now retired) |
| 226 | Chargeback Manager — per-company summary table | MD9 note: Replaced by inter-department internal invoices + elimination (II.4). Retire chargebacks page, overhead-rate API/service, chargeback service, cost-allocation, time-review. | Audit #226 (Cat 10); BuildSpec v4.3 §12; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ⛔; seq P3 (now retired) |
| 227 | Chargeback Invoice — 6 sections (COGS-Labor, OpEx-Labor, COGS-Expenses, OpEx-Expenses, Shared Costs, Direct Assigned) | MD9 note: Replaced by inter-department internal invoices + elimination (II.4). Retire chargebacks page, overhead-rate API/service, chargeback service, cost-allocation, time-review. | Audit #227 (Cat 10); BuildSpec v4.3 §12; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ⛔; seq P3 (now retired) |
| 228 | Chargeback Invoice — GL classification rules (Office=OpEx, Field=COGS/OpEx by job) | MD9 note: Replaced by inter-department internal invoices + elimination (II.4). Retire chargebacks page, overhead-rate API/service, chargeback service, cost-allocation, time-review. | Audit #228 (Cat 10); BuildSpec v4.3 §12; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ⛔; seq P3 (now retired) |
| 229 | Chargeback Invoice — Generate Invoice button (one-click, posts both sides) | MD9 note: Replaced by inter-department internal invoices + elimination (II.4). Retire chargebacks page, overhead-rate API/service, chargeback service, cost-allocation, time-review. | Audit #229 (Cat 10); BuildSpec v4.3 §12; MD9 Part V | Apr-26 audit: PARTIAL; MD9: ⛔; seq P3 (now retired) |
| 230 | Chargeback Invoice — full line-item detail with source lineage | MD9 note: Replaced by inter-department internal invoices + elimination (II.4). Retire chargebacks page, overhead-rate API/service, chargeback service, cost-allocation, time-review. | Audit #230 (Cat 10); BuildSpec v4.3 §12; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P3 (now retired) |
| 231 | Chargeback Invoice — invoice # format CB-2026-0215-SC | MD9 note: Replaced by inter-department internal invoices + elimination (II.4). Retire chargebacks page, overhead-rate API/service, chargeback service, cost-allocation, time-review. | Audit #231 (Cat 10); BuildSpec v4.3 §12; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P3 (now retired) |
| 232 | Cost Allocation Rules — Employee Classifications tab (4 types detailed) | MD9 note: Replaced by inter-department internal invoices + elimination (II.4). Retire chargebacks page, overhead-rate API/service, chargeback service, cost-allocation, time-review. | Audit #232 (Cat 10); BuildSpec v4.3 §12; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P3 (now retired) |
| 233 | Cost Allocation Rules — OH Auto-Calc Pipeline visual (QBO P&L feed) | MD9 note: Replaced by inter-department internal invoices + elimination (II.4). Retire chargebacks page, overhead-rate API/service, chargeback service, cost-allocation, time-review. | Audit #233 (Cat 10); BuildSpec v4.3 §12; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P3 (now retired) |
| 234 | Cost Allocation Rules — Expense Rules tab | MD9 note: Replaced by inter-department internal invoices + elimination (II.4). Retire chargebacks page, overhead-rate API/service, chargeback service, cost-allocation, time-review. | Audit #234 (Cat 10); BuildSpec v4.3 §12; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P3 (now retired) |
| 235 | Cost Allocation Rules — Shared Cost Rules tab (6 rules with $ amounts) | MD9 note: Replaced by inter-department internal invoices + elimination (II.4). Retire chargebacks page, overhead-rate API/service, chargeback service, cost-allocation, time-review. | Audit #235 (Cat 10); BuildSpec v4.3 §12; MD9 Part V | Apr-26 audit: SCHEMA; MD9: ⛔; seq P3 (now retired) |
| 236 | Time Review — imported from QB Time, AI correction suggestions | MD9 note: Replaced by inter-department internal invoices + elimination (II.4). Retire chargebacks page, overhead-rate API/service, chargeback service, cost-allocation, time-review. | Audit #236 (Cat 10); BuildSpec v4.3 §12; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P3 (now retired) |
| 237 | Time Review — batch "Approve All Corrected" | MD9 note: Replaced by inter-department internal invoices + elimination (II.4). Retire chargebacks page, overhead-rate API/service, chargeback service, cost-allocation, time-review. | Audit #237 (Cat 10); BuildSpec v4.3 §12; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P3 (now retired) |
| 238 | Two-phase chargeback (Merit-only Phase 1 + white-label Phase 2) — v3.1 enhancement | MD9 note: Replaced by inter-department internal invoices + elimination (II.4). Retire chargebacks page, overhead-rate API/service, chargeback service, cost-allocation, time-review. | Audit #238 (Cat 10); BuildSpec v4.3 §12; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P3 (now retired) |
| 347 | Department Setup Wizard — AI-powered (describe workflow in English) | MD9 note: replaced by Departments setup step (II.3); PM time in PM module | Audit #347 (Cat 17); BuildSpec v4.3 §24, §08; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔/❌ |
| 348 | Department Setup — Configuration Lock (web vs mobile) | MD9 note: replaced by Departments setup step (II.3); PM time in PM module | Audit #348 (Cat 17); BuildSpec v4.3 §24, §08; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔/❌ |
| 349 | Department Setup — Overview Grid with status cards | MD9 note: replaced by Departments setup step (II.3); PM time in PM module | Audit #349 (Cat 17); BuildSpec v4.3 §24, §08; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔/❌ |
| 350 | Department Setup — PM tool integrations (ClickUp, Jira, etc.) | MD9 note: replaced by Departments setup step (II.3); PM time in PM module | Audit #350 (Cat 17); BuildSpec v4.3 §24, §08; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔/❌ |
| 374 | Org Setup Wizard — Step 6: Overhead Allocation Configuration | MD9 note: REPLACE with Departments + charge-method (II.3) | Audit #374 (Cat 19); BuildSpec v4.3 §08; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P4-MED |
| 383 | Time Clock — Company picker (assigned + supervisor-gated) | MD9 note: OUT — PM module | Audit #383 (Cat 20); BuildSpec v4.3 §15; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P6-FUTURE |
| 384 | Time Clock — Job picker (from ERP sync) | MD9 note: OUT — PM module | Audit #384 (Cat 20); BuildSpec v4.3 §15; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P6-FUTURE |
| 385 | Time Clock — Phase picker (Demo, Rough-In, Trim, Punch List) | MD9 note: OUT — PM module | Audit #385 (Cat 20); BuildSpec v4.3 §15; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P6-FUTURE |
| 386 | Time Clock — Live timer with GPS confirmation | MD9 note: OUT — PM module | Audit #386 (Cat 20); BuildSpec v4.3 §15; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P6-FUTURE |
| 387 | Time Clock — Manual hours for office workers (no timer, no GPS) | MD9 note: OUT — PM module | Audit #387 (Cat 20); BuildSpec v4.3 §15; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P6-FUTURE |
| 388 | Time Clock — 6 department-specific quick-tag sets | MD9 note: OUT — PM module | Audit #388 (Cat 20); BuildSpec v4.3 §15; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P6-FUTURE |
| 389 | Time Clock — Merit/All access supervisor approval gate | MD9 note: OUT — PM module | Audit #389 (Cat 20); BuildSpec v4.3 §15; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P6-FUTURE |
| 390 | Time Clock — Switch job capability during active timer | MD9 note: OUT — PM module | Audit #390 (Cat 20); BuildSpec v4.3 §15; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P6-FUTURE |
| 391 | Time Clock — Time history (this week + last week) | MD9 note: OUT — PM module | Audit #391 (Cat 20); BuildSpec v4.3 §15; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P6-FUTURE |
| 399 | Mobile Department Setup — 4-step wizard | MD9 note: out | Audit #399 (Cat 20); BuildSpec v4.3 §15; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P6-FUTURE |
| 405 | 3 mobile roles (Field Worker, Department Head, Cardholder) | MD9 note: mobile/time out | Audit #405 (Cat 21); BuildSpec v4.3 §16–17; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P4-MED |
| 421 | Monthly 1st 12:01 AM: OH Rate Recalculation (pull P&L → recalc burden rate) | MD9 note: obsolete | Audit #421 (Cat 22); BuildSpec v4.3 §19; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔ |
| 423 | Configurable cadence: Chargeback Generation | MD9 note: obsolete (→ internal-invoice reminders if any) | Audit #423 (Cat 22); BuildSpec v4.3 §19; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔ |
| 427 | Office worker start/stop timer (no GPS) on web + mobile | MD9 note: time out | Audit #427 (Cat 23); BuildSpec v4.3 §25; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P6-FUTURE |
| 429 | Two-phase chargebacks (Merit Phase 1 + white-label Phase 2) |  | Audit #429 (Cat 23); BuildSpec v4.3 §25; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P6-FUTURE |
| 434 | CPA Desk → MeritContext (persistent memory across sessions) | MD9 note: MeritContext out | Audit #434 (Cat 23); BuildSpec v4.3 §25; MD9 Part V | Apr-26 audit: MISSING; MD9: ⛔; seq P6-FUTURE |
| S-1408 | MeritContext (persistent AI memory) — do not reference or build |  | MD9 I.3, VI | RETIRED |
| S-1409 | Platform fee income posted onto Merit's own tenant books (4910) via PLATFORM_ORG_ID | Later retired S41 — Merit books own processor income via its bank feed | MD9 GATE 12.1 vs CLAUDE.md S41 | RETIRED |
| S-1410 | Chargebacks, overhead, labor classes, cost allocation, in-app time, time review, time clock, AI Dept Setup Wizard, MeritContext | — | [H] D40 Part VI; ANCHOR §2 | RETIRED |
| S-1411 | No "portfolio" concept | — | [H] OD | Owner directive |
| S-1412 | No automation layer on QBO/Sage | — | [H] D20; ANCHOR §1 | Retired |
| S-1413 | Coded platform-fee GL posting | Merit books processor income via its own bank feed | [H] S41 | RETIRED |
| S-1414 | Inventory depth reserved for MeritInventory | — | [H] D10 core.items | Do not build now (see contradictions) |
| S-1415 | Deferred items | Multi-currency; embeddings; multi-book | [H] D20; S50 | Deferred |
| S-1416 | Legacy routes | `/recurring`, `/invoices/collections` | [H] S45 | Cleanup pending |
| S-1417 | Banned design patterns | Emerald-on-black theme, banners, legacy UI | [H] CLAUDE.md | Binding |

## Contradictions between documents

### Product model and scope

1. **Feature count: 461 vs 436.** The audit's summary tables and Master Doc Part V both say "461 features". The numbered items stop at **#436**. The category totals are miscounted.
2. **Brand and design system.**
   - These all specify emerald `#10b981` on a dark theme with Plus Jakarta Sans + JetBrains Mono: Platform Design Criteria, Marketing-Brand-Pricing, Master Doc GATE 10, memory.md, BuildSpec §27, and audit #418.
   - The binding CLAUDE.md design system is Merit Suite Style Guide v2.3: Electric Blue, Syne + DM Sans. It explicitly bans emerald-on-black, Plus Jakarta Sans and JetBrains Mono.
   - The live marketing site still uses the emerald brand.
3. **Chart of accounts.**
   - Session 10 says the COA is "hardcoded, permanent", 251 accounts, and survives a wipe.
   - Master Doc I.5 / III.2 / II.7 Step 4 say it is a **per-tenant seed template**: a tenant can use the standard, bring its own, or merge.
   - The spec'd chart is 251 accounts. The encoded template is 137, which Mike accepted "for now" (MD9 XI.6).
4. **"Portfolio" language.**
   - The owner directive (2026-10-18) says "there is no such thing as portfolio": Merit is a tenant and its companies are clients.
   - BuildSpec v4.3, MD9 GATE 11a ("PE/holding-company"), the marketing positioning ("multi-entity / portfolio moat") and later handoffs (S42, S47, S48) still use it.
5. **Tenant model and practice management.**
   - BuildSpec §26 and audit Cat 16 treat Practice / accounting-firm features as *future* (after MeritWork).
   - The owner directive makes accounting firms with client books a primary tenant type.
   - The bookkeeper is named the primary user.
6. **Roles.** Four different role sets are specified:
   - BuildSpec §17: 7 web roles (Org Admin, CFO, Acct Mgr, Sr Accountant, Accountant, Check Processor, Viewer) plus 3 mobile roles.
   - MD9 IV.3: 9 roles (Company Admin, CFO, Merit Controller, Assistant CFO, Acct Mgr, Acct Specialist, Check Processor, General Admin, Business User). "Merit Controller" breaks the no-Merit-hardcoding rule.
   - MD9 II.7 Step 10: "one of the 9 roles".
   - Owner directive: owner, CFO, controller, finance director, accounting manager, bookkeeper, HR/payroll, operations leader, plus platform admin and tenant-admin delegation.
7. **Consolidation visibility.** The owner directive says any consolidator client can consolidate, gated by permission. S47 gates it to admins only ([H]).

### Accounting rules and statuses

8. **Revenue-recognition methods.**
   - 4 methods: BuildSpec v4.3, audit #186, MD9 VIII.1, and onboarding Step 9 ("4 options").
   - 8 methods: Handoff S8.
   - 9 methods: the engine and the Posting Engine Spec Part F.
9. **Auto-approve vs auto-post.**
   - BuildSpec §06 and CLAUDE.md define live auto-approve: ≥85% + trusted vendor + ≤$10k; receipts auto-approve under $25 by default.
   - MD9 II.5 / VIII.7 and the Posting Engine Spec say auto-post is **OFF by default**, enabled per task only after demonstrated accuracy.
   - Two scoring tiers coexist: composite ≥90 / 70–89 / <70 and AI ≥85 / 50–84 / <50.
10. **Fixing a posted invoice.**
    - The Event Contract §4 says use a credit memo, adjustment, or void-and-reissue.
    - Mike later chose **edit-with-override with reverse-and-repost** over void/credit-memo lockout (MD9 XI.12).
11. **BuildSpec v4.3 status claims are unreliable.** The §04 tables mark items BUILT that the same-date audit marks MISSING. Examples:
    - JE approval workflows (#12)
    - positive pay (#48)
    - separation of duties (#51)
    - receipt chase (#293–297)
    - working papers (#136)
    - period close gate (#139)
    - recurring bills (#35)
12. **Multi-book.**
    - Audit #5 asks for GAAP, tax, cash and accrual books simultaneously.
    - MD9 X.1 decided cash basis is a **reporting layer** over the accrual book, with dual-book only for depreciation.
    - No document resolves tax books or alternate COAs (#18).

### Retired items, payments and inventory

13. **MeritContext.**
    - BuildSpec §25 #9 and Suite Architecture §6 (module 5, "MeritContext / MeritAgent") plan it.
    - MD9 I.3 says it "does not exist… do not reference or build it".
14. **Chargebacks.** Retired in Session 12 (MD9 Part VI). Still present in:
    - BuildSpec §25 #10 (tiers "chargeback engine excluded"),
    - the CLAUDE.md "Code Organization" and "Database" sections (chargebacks/generate, overhead-rate),
    - the S10 rule that "portfolio companies… [are] locations with a chargeback flag".
15. **Pricing and tiers.**
    - BuildSpec §25 #10: Processor / Practice / Complete white-label tiers.
    - Earlier: Solo $79 / Portfolio $349 (retired).
    - Current (Marketing, 2026-08-02): **$99/company for the first 5, $59 thereafter**; firms pay $499/mo + $59/$49/$39 wholesale; Enterprise is custom.
    - MD9 X.1 still lists tiers and packaging as open.
16. **ACH fee.**
    - S37, MD9 and Marketing: 1% **uncapped**.
    - S38 ([H]): 1% capped at $10 with per-merchant schedules.
17. **Platform-fee income posting.** Built in S37 (MD9 GATE 12.1, migration 052, `PLATFORM_ORG_ID`). **Retired in S41**: Merit books its processor income through its own bank feed.
18. **Inventory.**
    - The Suite Architecture reserves on-hand quantity and valuation for MeritInventory.
    - MD9 GATE 11c puts inventory costing in Books.
    - S47 and S49 built an inventory MVP in Books ([H]).
19. **Customer deposits.**
    - MD9 X.1: advances default to Deferred Revenue 2410; refundable deposits go to 2420.
    - S50 ([H]): deposits and retainers post to 2420.
20. **Year-end close assumes a Dec 31 year-end** (MD9 XI.9). But fiscal-year start month is configurable per company (BuildSpec §08, II.7 Step 2).

### Build-state claims in the discovery docs

21. **Discovery docs disagree on build state** for several capabilities ([D1]/[D2]):
    - covenant monitor and borrowing base (built per GAP §5, not built per CATv2/COV);
    - ASC 740 / book-to-tax;
    - 1099 e-file (FIRE);
    - close command center;
    - AI cash application;
    - missed-accrual drafting;
    - AR control account number (1100 vs 1200);
    - detector count (10 vs 12).
22. **Who owns the bill-pay rail.**
    - GAP §2 recommends Ramp own bill-pay rails, cards and reimbursements.
    - INT §4 and MD9 GATE 12.2 recommend a MeritBooks disbursement adapter (Melio-style / Modern Treasury), bring-your-own-bank.
23. **SMS.** The receipt chase is specified as Push+SMS (BuildSpec §24, MD9 VIII.3) and the settings UI shows SMS preferences. No SMS provider is specified or wired (INT F3, GAP #31).

## Features dropped or orphaned between versions

- **Master Doc v8 → v9: nothing was dropped.** A normalized diff shows v9 is a strict superset. The only changes are additions and status updates:
  - Session 37 banner;
  - I.5a Stripe conventions;
  - migrations 050–052;
  - IV.1 now listing branded PDF, hosted pay page, Stripe Pay Now and the Payments screen;
  - the Invoices row in the V.0 ledger upgraded;
  - GATE 12.1 changed from "adapter NOT BUILT" to built and deployed.
- **Silently dropped from the Master Doc register, both v8 and v9:** audit **#336–#343** (team stack rankings, the four ranking views, five time periods, status badges, billing efficiency, utilization flag). Category 17 jumps from #335 to #344.
  - Part VI retires only "production utilization flagging".
  - The stack rankings themselves (#336–341) were never retired, yet they vanished from the register.
  - Team performance resurfaces later in the repo FPB and handoffs ([H], [D1]).
- **Retired by decision (Part VI / Session 12) — listed in the Retired domain:**
  - the whole chargeback category (#221–238), with time review (#236–237);
  - overhead config onboarding step (#374) and chargeback-rules training (#379, partly);
  - AI department setup wizard and PM-tool time integrations (#347–350);
  - mobile time clock (#383–391), mobile department setup (#399), mobile roles (#405), office-worker timer (#427);
  - monthly OH recalculation (#421), chargeback generation (#423), two-phase chargebacks (#429);
  - CPA Desk → MeritContext (#434).
- **Specified but given no roadmap gate in MD9 Part VII** (so they were never scheduled):
  - physical asset tracking (#309–323, "future");
  - practice and client management (#324–335, "future");
  - System Console (#362–365, "optional/long-term"), Suggest-a-Feature (#366), mobile activity feed (#400), Asset Panda sync (#323 / #430);
  - borrowing base (#431), subscription tracker (#432), white-label tiers and module selection (#435–436);
  - statistical accounts (#7), multi-book (#5), reporting/alternate COAs (#18), JE import from spreadsheet (#13);
  - debt and equity schedules UI (#208–209);
  - check management (#200–202, mentioned only as "needed for the NL 'queue check'");
  - intercompany loan workflow with AI-drafted promissory note / resolution and e-signature (#204–206);
  - compliance-dashboard metrics and filing archive (#148–152);
  - dark/light toggle (#416) and company switcher (#417).
- **Superseded wording:**
  - BuildSpec §27 #9's "World-class UI redesign (emerald)" is superseded by the merit-ui v2.3 port.
  - Department setup / time-clock configuration is superseded by the Departments + internal-charge-method step (MD9 II.3).
