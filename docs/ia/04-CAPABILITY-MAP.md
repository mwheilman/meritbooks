# MeritBooks — Capability Map (what the platform must do, and where each piece lives in the new IA)

**Status:** reference for the IA / role-dashboard build · authored 2026-10-18 · read-only analysis (no code changed).
**Why this exists:** the owner flagged that the new role designs (IA-SPEC) left out rev rec, receipt chase, FP&A,
debt covenants, the check processor and more. This file lists **every capability the platform is meant to have**,
says what the code already has for each one, and places each in the new IA, so the new shell is built from the
existing product instead of a smaller copy of it.

**Sources, highest authority first** (owner directive `00-OWNER-DIRECTIVE.md` wins on IA questions):
Master Doc v9 (**MD**; `#n` = audit/register item, `II.x`/`VIII.x` = section, `G` = gate) → suite contracts (**SC**: architecture,
ownership matrix, identity model) → Posting Engine Spec (**PE**) → Build Spec v4.3 (**BS §n**) → handoffs/canon (**CA** =
`CANON-ANCHOR.md`) → FPBs (**FPB-x**) → `COMPETITIVE-GAP-ANALYSIS-2026-10.md` (**CG#n**) → `NORTH-STAR.md` (**NS**) →
`REV-REC-WIP-SPEC.md` (**RRS**) → `IA-SPEC.md` (**IA**). Code status comes from `03-CODE-INVENTORY.md`, checked against
`apps/web/src/lib/navigation.ts`, the `(app)/` page tree (incl. redirect stubs) and `lib/`.

**Legend**
- **Status:** `LIVE` = real data, wired · `PARTIAL` = exists with gaps, needs AI/credentials, or detect-only · `STUB` = mock/sandbox
  adapter only · `PLANNED` = specified, no code · `RETIRED` = do not build (see §Retired). Global caveats: Plaid SANDBOX,
  Stripe TEST, Clerk dev instance, Anthropic org disabled (AI features fall back to rules, or show "AI paused").
- **Roles:** PA platform admin · PS platform support · TA tenant admin · AM accounting manager · BK bookkeeper (primary
  user) · OW owner · CFO · CTL controller · FD finance director · HR HR/payroll · DH department head / operations leader ·
  PC payments clerk (**"Check processor"**) · DE data entry · AU external auditor / view-only · CC client contact ·
  **EM employee / cardholder (new, see G2)** · **LV lender / investor viewer (new, see G4)**.
- **IA home:** context `P` platform · `W` tenant workspace · `C` client books · `X` consolidated view, then the nav group
  from IA §3.4–3.6 (`C·Payables`, `W·Work`, …). Hub pages use `?tab=` (existing pattern).
- **Widgets:** plain ids exist in IA §4/§5.4. **`+id` = new widget proposed in this file** (defined in §Coverage gaps).
- **Auto:** `AUTO` system does it (deterministic) · `PROPOSE` AI or the rules engine drafts it and a human approves (canon: the AI proposes facts,
  the deterministic engine posts) · `DETECT` flags only · `HUMAN` a person does it.

---

## 1. Capability catalog

### 1.1 General ledger & chart of accounts
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| GL-01 | **Double-entry GL** — `postJournalEntry` + `check_journal_balance()` + 6 triggers; debit/credit direction derived from account type | MD#1–28, PE, G2 | LIVE · `lib/posting/*` | all | infrastructure | — | AUTO |
| GL-02 | **Account-role registry** — accounts resolved by role, not number | PE, CA§2 | LIVE · `lib/posting/account-roles.ts`, mig 094 | CTL | C·Client settings (accounting setup) | — | AUTO |
| GL-03 | **Chart of accounts** — per-tenant seed template (137 accts), tree, grouped balances | MD#2,3,10,25 | LIVE · `/chart-of-accounts` | CTL, BK | C·Accounting | — | HUMAN |
| GL-04 | **COA approval workflow** — request → approve → activate | MD#9 | LIVE · `enforce_coa_approval` | BK req, AM/CTL appr | C·Accounting | am.review_queue | HUMAN |
| GL-05 | **Control-account & company-specific account protection** | MD#26,27 | LIVE · triggers | CTL | infra | — | AUTO |
| GL-06 | **Manual JEs** — draft/post/reverse; edit-with-override (typed reason, reverse + re-post) | MD#175–177, XI.12 | LIVE · `/journal-entries` | BK create, AM/CTL post | C·Accounting | am.review_queue, ctl.manual_jes | HUMAN |
| GL-07 | **NL JE composer** — plain English → balanced draft; can attach "queue check", schedules, recurring | MD II.5, #11 | PARTIAL (AI dark) · `components/nl/*`, JE_COMPOSER | BK, CTL | C·Accounting + ⌘K | — | PROPOSE |
| GL-08 | **JE approval chain** — sequential approvers by amount/source | MD#12, CG#4 | PARTIAL · engine mig 092, not enforced on every JE | AM, CTL | W·Settings·Approval workflows | am.review_queue | HUMAN |
| GL-09 | **Recurring JEs** — propose → approve → post, reversing | MD#14,183–185 | LIVE · `/journal-entries?tab=recurring`, `lib/recurring-je` | BK, CTL | C·Accounting | bk.done_for_you, +ctl.schedules | PROPOSE |
| GL-10 | **JE import from spreadsheet** | MD#13 | PLANNED (generic `/import` exists) | BK | C·Accounting | — | HUMAN |
| GL-11 | **Year-end close to retained earnings**, per client | MD#16 | LIVE · `/close?tab=year-end` | CTL | C·Home·Close | ctl.periods | PROPOSE |
| GL-12 | **Period 13 / adjusting period** | MD#15 | PLANNED (schema 1–13) | CTL | C·Accounting·Fiscal periods | — | HUMAN |
| GL-13 | **Statistical accounts & journals** (headcount, sq ft) | MD#7 | PLANNED | CTL | C·Accounting | — | HUMAN |
| GL-14 | **Reporting-basis overlay** — accrual/cash/tax/custom, non-posting | MD#5, mig 147 | LIVE · `/reports/basis-adjustments` | CTL | C·Reports | — | HUMAN |
| GL-15 | **Full parallel multi-book ledger** | MD#5 | PLANNED (deferred by design) | CTL | — | — | — |
| GL-16 | **Alternate / reporting COAs** | MD#18 | PLANNED | CTL | C·Accounting | — | — |
| GL-17 | **Field-level JE audit trail** | MD#21 | LIVE · `audit_log`, `v_journal_entry_audit` | AU, CTL | C·Controls·Audit trail | au.audit_trail | AUTO |
| GL-18 | **Anomalous JE detector (EC-10)** | MD#19, FPB-fce | LIVE · `lib/controls/anomalous-je.ts` | CTL | C·Home step 3 | ctl.manual_jes | DETECT |
| GL-19 | **Transactional multi-currency** | MD G11 (deferred), CG#30 | PLANNED (currency columns only; FX in consolidation) | CTL | — | — | — |
| GL-20 | **Closed-period edit → approval-queued proposal** | CG#11 | PLANNED (DB hard-blocks today) | CTL | W·Work·Review queue | am.review_queue | PROPOSE |

### 1.2 Dimensions
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| DIM-01 | **Four dimensions on every line** (client/dept/class/item) + job | MD#1, II.1 | LIVE | all | infra | — | AUTO |
| DIM-02 | **Required-dimension enforcement** (stricter of account/client) | MD#20 | LIVE · `validate_dimensions` | CTL | C·Client settings | — | AUTO |
| DIM-03 | **Departments** — user-defined hierarchy, own P&L/budget, internal-charge method | MD II.1–3 | LIVE · `/departments` | CTL, DH | C·Accounting | dh.bva | HUMAN |
| DIM-04 | **Classes** management | MD#89 | PARTIAL · `/api/classes`, P&L by class; no page | CTL | C·Accounting (tab) | — | HUMAN |
| DIM-05 | **Items** (core) — price/cost/GL mapping | SC ownership | PARTIAL · via inventory items | BK | C·Jobs & costing·Inventory | — | HUMAN |
| DIM-06 | **Dimension-combination reporting & budgets** | MD G11, G7 | PARTIAL · P&L by dept/class | CTL, FD | C·Reports | — | AUTO |
| DIM-07 | **Department-scoped access for department heads** | IA M-3 | PLANNED | DH | membership | dh.* | — |

### 1.3 Periods & close
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| CLS-01 | **Fiscal periods** OPEN/SOFT/HARD per client-month; DB lock (152) + posted immutability (153) | MD#6, CA | LIVE · `/periods` | CTL | C·Accounting·Fiscal periods | ctl.periods, au.periods | AUTO |
| CLS-02 | **Close Command Center** — ordered task graph, 14 auto-verified checks (⚡), blocking hard-close gate | MD#121–146, VIII.5 | LIVE · `/close`, `lib/close/orchestration.ts` | BK, AM, CTL | C·Home·Close (step 4) | am.close_grid | AUTO + HUMAN |
| CLS-03 | **Close status across clients** | MD#121 | LIVE · `/close?tab=status`, `close-grid.tsx` | AM, CTL, CFO, OW | W·Work·Close grid | am.close_grid, cfo.close_blockers, ow.books_status | AUTO |
| CLS-04 | **3-phase close template & due dates** (initial d3 / mid d7 / final d10; tenant/client due day) | VIII.5, BS §13, IA M-1/M-2 | PARTIAL · tasks exist; due-day columns planned | AM | C·Client settings·Close checklist template | bk.agenda | HUMAN |
| CLS-05 | **Close package / client packet export** (P&L/BS/cash + narrative) | IA §6.14 | PARTIAL · export LIVE, narrative AI | BK, AM | C·Home·Close | ow.books_status | PROPOSE |
| CLS-06 | **Close-run agent** — close procedure in plain English, agents run steps, pause for approval | CG#9, MD G9a | PARTIAL · `lib/agents/recipes/close-run.ts` | AM, CTL | C·Home·Close | bk.done_for_you, +ai.agent_gates | PROPOSE |
| CLS-07 | **Working papers** — balance-sheet account support, 5 tickmarks, preparer/reviewer sign-off | MD#136–138, BS §13 | PLANNED (table exists) | BK, CTL, AU | C·Home·Close (tab) | +ctl.working_papers | HUMAN |
| CLS-08 | **Ready-for-review → reviewer approve/return with note** | IA §4.1–4.2 | PLANNED | BK, AM | W·Work·Review queue | am.review_queue | HUMAN |
| CLS-09 | **Group close gate + post-close package** — group closes only when every member has | CG#5 | PARTIAL · close board only | CFO, CTL | X | cfo.close_blockers | AUTO |
| CLS-10 | **Gate override with documented reason** | MD#146 | PARTIAL | CTL, CFO | C·Home·Close | — | HUMAN |
| CLS-11 | **Close-readiness score / continuous close** | MD G9a | PARTIAL · `lib/close/readiness.ts` | AM | W·Work·Close grid | bk.my_clients | AUTO |
| CLS-12 | **Books-review loop** Review → Reconcile → Check → Close | IA §4.1 | PLANNED (built from existing queues) | BK | C·Home | client home | AUTO + HUMAN |
| CLS-13 | **Subledger ↔ GL tie-outs** (AR, AP, inventory, payroll, prepaid, deposits) | mig 149, CA S50 | LIVE | CTL | C·Home step 3 | ctl.close_through | AUTO |
| CLS-14 | **Distance from close + time standards** | IA M-10 | PLANNED | BK, AM | — | bk.my_clients, am.capacity | AUTO |

### 1.4 Bank & card feeds (incl. Ramp)
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| BNK-01 | **Plaid connect/sync/map**, entity-first, per-account GL | MD G12.0 | LIVE (sandbox) · `lib/money/plaid-feed.ts` | BK, TA | C·Client settings·Bank connections | bk.feeds, ta.connections | AUTO |
| BNK-02 | **Bank-feed review** — confidence bands, Approve/Flag/Edit, j/k/a/f keys, ≥90% select, vendor batch, inline GL search with vendor recents, AI reasoning | CLAUDE.md, MD#160–163, BS §9 | LIVE · `/bank-feed` | BK | C·Home·To review | bk.ai_judgment | PROPOSE |
| BNK-03 | **Two-phase categorization** rules → vendor memory → AI, learns from approvals | MD II.5, #367 | LIVE (memory works with AI down) · `lib/learning` | BK | — | bk.done_for_you | AUTO/PROPOSE |
| BNK-04 | **Auto-approve under the autonomy dial** (≥85% AND trusted vendor AND ≤$10k) | VIII.2, CLAUDE.md | PARTIAL · dial LIVE; auto-post OFF | CTL, TA | W·Settings·AI autonomy | bk.done_for_you | AUTO |
| BNK-05 | **Saved views, bulk by band/vendor, confidence explainer** | S49 | LIVE · `confidence-explainer.tsx` | BK | C·Home·To review | — | — |
| BNK-06 | **Duplicate detection on feed** (EC-1) | FPB-fce | LIVE | BK | step 1 | bk.ai_judgment | DETECT |
| BNK-07 | **Credit-card feed** → Credit Card Payable; receipt status + chase count per txn | MD#164–165, BS §9 | LIVE · `/bank-feed?tab=credit-cards` | BK | C·Home·To review | bk.ai_judgment, +exp.missing_receipts | PROPOSE |
| BNK-08 | **Ramp two-way accounting connection** — push COA/dims/vendors/entities; pull `ready_to_sync` card txns, bills, reimbursements with receipts + Ramp coding; acknowledge syncs | CG#1, CG§2 | PLANNED (none; top priority) | BK, TA | W·Settings·Integrations; feeds into C·To review | bk.feeds, pf.integrations | AUTO + PROPOSE |
| BNK-09 | **Ramp pairing & completeness** — pair statement payment to posted entry; Ramp-vs-GL completeness detector; accrue unsynced spend at month end | CG§2 | PLANNED | BK, CTL | step 1 / step 3 | +exp.missing_receipts, ctl.close_through | DETECT/PROPOSE |
| BNK-10 | **Statement PDF import** (AI) for non-Plaid accounts | MD#75 | PARTIAL · `statement-import.tsx` | BK | C·Banking·Reconciliation | — | PROPOSE |
| BNK-11 | **File import** CSV/OFX/QFX/BAI2/CAMT | MD#75, BS §4 | PLANNED | BK | C·Banking | — | AUTO |
| BNK-12 | **Transfer pairing** between own accounts and clients | MD#82, IA §6.4 | PLANNED | BK | step 1 | — | AUTO |
| BNK-13 | **Bill/invoice payment match on feed** (no re-expense) | PE, G2 | LIVE · `lib/posting/lifecycle.ts` | BK | step 1 | — | AUTO |
| BNK-14 | **Scheduled daily pull + categorize** | MD#420, CG#2 | PLANNED (no scheduler) | — | infra (INT-16) | — | AUTO |
| BNK-15 | **Direct card-issuer connectors** (Amex, bank cards) | PRODUCT-FEATURE-OVERVIEW | PLANNED | BK | C·Client settings | bk.feeds | AUTO |

### 1.5 Reconciliation
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| REC-01 | **Reconciliation workspace** — statement vs GL, cleared/uncleared, finalize & lock | FPB-bank-rec | LIVE · `/reconciliation` | BK | C·Home step 2 / C·Banking | bk.unreconciled | HUMAN |
| REC-02 | **Autopilot match** vendor 40 / amount 40 / date 20 | VIII.2 | LIVE | BK | step 2 | — | AUTO |
| REC-03 | **AI adjustment suggestions + rec memo** | FPB-bank-rec D6 | PARTIAL (AI) | BK | step 2 | — | PROPOSE |
| REC-04 | **Difference decomposer + outstanding-item aging** | S49 | LIVE | BK | step 2 | bk.unreconciled | AUTO |
| REC-05 | **Rec history / reports / unreconcile** | MD#84,112 | LIVE (read-only history) | BK, AU | C·Banking·Reconciliation | — | — |
| REC-06 | **Preparer sign + reviewer sign-off** | IA §4.7 | PARTIAL · finalize LIVE, reviewer planned | BK, CTL | step 2 | ctl.rec_signoff | HUMAN |
| REC-07 | **Card & loan account reconciliation** | IA §4.1 | PARTIAL | BK | step 2 | bk.unreconciled | HUMAN |
| REC-08 | **Evidence pinned to statement PDF; "lines broke a reconciled account" alert** | CG#12 | PLANNED | BK, CTL | step 2 | ctl.rec_signoff | DETECT |
| REC-09 | **Must-tie-to-zero close gate** | FPB-bank-rec D10 | LIVE | CTL | step 4 | — | AUTO |

### 1.6 AP · bills · PO · 3-way match
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| AP-01 | **Bills** — create/edit/hold, dims, AP subledger (DR exp / CR AP; pay clears AP) | MD#29–30, PE | LIVE · `/bills` | BK, DE | C·Payables·Bills | — | HUMAN |
| AP-02 | **AI bill intake queue** (drop-and-parse; Azure DI) | MD#29, NS §6.1 | PARTIAL (Azure creds; LLM-vision path) · `/bills/intake-queue`, `lib/ap/doc-intelligence` | BK, DE | C·Home·To review (Bills) | +ap.intake | PROPOSE |
| AP-03 | **AP inbox → bill** (per-tenant/client address; M365 mailbox list) | MD G4, mig 135 | PARTIAL (webhook; no mail provider; GATE 4 blocked) · `lib/ap/inbound-intake.ts` | BK | C·Client settings·Inboxes | +ap.intake, bk.feeds | AUTO + PROPOSE |
| AP-04 | **AP policy engine** (plain-English rules) | S45 | LIVE · `/bills/policy` | CTL, AM | C·Payables·Bills (tab) | — | AUTO |
| AP-05 | **Duplicate bill / bill anomaly detection** | MD#31 | LIVE · `bill-anomaly.ts`, EC-1 | BK | step 1/3 | am.exceptions | DETECT |
| AP-06 | **N-step approval workflows** by doc type/amount; chain visualizer; simulator; coverage-gap detector | MD#32, G11e | LIVE · `/settings/approvals`; enforcement PARTIAL (CG#4) | TA, AM, DH, OW | W·Settings·Approval workflows | dh.approvals, ow.decisions | HUMAN |
| AP-07 | **Approval delegation** (out-of-office) | MD#33 | PLANNED | DH, OW | profile | — | HUMAN |
| AP-08 | **AI-learned vendor defaults** (GL, dept, job, terms) | MD#34 | LIVE · vendor memory | BK | C·Payables·Vendors | — | AUTO |
| AP-09 | **Recurring bills** | MD#35 | PLANNED | BK | C·Payables·Bills | — | PROPOSE |
| AP-10 | **Vendor credits / debit memos** | MD#43 | PARTIAL · posting template only, no UI | BK | C·Payables·Bills | — | HUMAN |
| AP-11 | **Purchase orders + goods receipts + 3-way match** with tolerances | MD#36,44–45, G11b | LIVE · `/purchase-orders`, `lib/procurement` | BK, DH | C·Payables·Purchase orders | dh.pos, +ap.match_exceptions | AUTO |
| AP-12 | **Requisitions → approval → PO; encumbrance** | MD#46–47, G11b | PLANNED | DH | C·Payables·Purchase orders | dh.approvals | HUMAN |
| AP-13 | **Early-pay discount capture** (2/10 net 30) | MD#42 | PLANNED | BK, PC | C·Payables·Pay runs | +ap.due | PROPOSE |
| AP-14 | **Cost-approval rules** | S44 | LIVE · `/api/cost-approvals` | AM | W·Settings·Approval workflows | — | AUTO |
| AP-15 | **AP aging / bills due planning** | MD#107 | LIVE (report) | BK, CFO | C·Reports | +ap.due | — |
| AP-16 | **Pay-time compliance hold** (W-9/COI badge on bill) | MD#170, VIII.4 | LIVE · mig 037 | BK, AM | C·Payables·Bills | +ap.holds | AUTO |
| AP-17 | **AP inbox agent** — vendor replies drafted, email threads on the bill | CG#14 | PLANNED | BK | C·Payables·Bills | — | PROPOSE |

### 1.7 Payments · check processing · pay runs · positive pay · ACH
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| PAY-01 | **Pay runs / check run** — assemble by due date, check-number assignment, approve, release, remittance PDF | NS §2A, BS §10, MD#200 | LIVE · `/checks`, `lib/ap/disbursement-batch.ts`, `/api/ap/disbursements/*` | PC prepares, CFO releases | C·Payables·Pay runs | pc.queue, cfo.release | PROPOSE + HUMAN |
| PAY-02 | **Pay-run agent proposal** (due-date driven run drafted for approval) | NS §6.3 | PARTIAL · `lib/agents/recipes/pay-run.ts` | BK, AM | C·Payables·Pay runs | +ap.pay_run_proposal | PROPOSE |
| PAY-03 | **Money-movement SoD** preparer ≠ approver ≠ releaser (DB CHECK) | MD G12, mig 042 | LIVE | PC, CFO | — | — | AUTO |
| PAY-04 | **Payment-run fraud screen** (new payee, BEC, unusual, duplicate) — blocks at release | S43 | LIVE · `payment-fraud.ts`, `PaymentFraudCard.tsx` | CFO | release dialog | cfo.release | DETECT |
| PAY-05 | **Check printing** — check stock, MICR, signatures, print batch | BS §10 | PLANNED | PC | C·Payables·Pay runs (Print tab) | +pc.print | HUMAN |
| PAY-06 | **Check history** — printed/cleared/void/stale, void-reissue | BS §10, MD#201 | PARTIAL · batch list; no clear/stale tracking | PC, BK | Pay runs (History tab) | +pc.history | AUTO |
| PAY-07 | **Positive pay** — issue file + bank exception approve/reject | MD#48,202, BS §10 | PARTIAL · CSV export only (`disbursement-export.ts`) | PC, CFO | Pay runs (Positive pay tab) | +pc.positive_pay | HUMAN |
| PAY-08 | **NACHA ACH export** | S49 | PARTIAL · NACHA-shaped export | PC | Pay runs | — | AUTO |
| PAY-09 | **ACH/wire origination via a licensed provider** (posts on release; never Books as regulated party) | MD G12.2 | STUB · sandbox adapter `lib/money/origination` | CFO | Pay runs | cfo.release | HUMAN |
| PAY-10 | **Vendor payment profiles** (method, tokenized bank details) | mig 137 | LIVE | BK, PC | C·Payables·Vendors | — | — |
| PAY-11 | **Virtual-card payments** | MD#39 | PLANNED | PC | Pay runs | — | — |
| PAY-12 | **Scheduled payments** (pay on date) | MD#41 | PLANNED | PC | Pay runs | +ap.due | AUTO |
| PAY-13 | **Approve-by-exception payments** (pre-vet vs budget/contract/compliance/duplicate/fraud) | MD G5 | PARTIAL | CFO, OW | ow.decisions | cfo.release | PROPOSE |
| PAY-14 | **Per-route payment permissions** (check_run ≠ payroll_release) | CA task #56 | PARTIAL · 4 granular keys | TA | W·Settings·Roles | — | — |
| PAY-15 | **Customer refunds paid out** | PE | PARTIAL · template | BK | C·Receivables | — | HUMAN |

### 1.8 Expenses · receipts · receipt chase
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| EXP-01 | **Receipt capture** — upload, AI parse, categorize, submit | MD#166, BS §9 | LIVE · `/receipts` | EM, DE, BK | C·Payables·Receipts | +em.my_receipts | PROPOSE |
| EXP-02 | **Receipt ↔ card/bank match** | MD#292 | LIVE/PARTIAL | BK | step 1 | +exp.missing_receipts | AUTO |
| EXP-03 | **Mobile receipt capture** (camera, PWA) | MD#289,392–398 | PLANNED | EM | mobile | +em.my_receipts | — |
| EXP-04 | **Email receipt ingestion** | MD#290 | PLANNED (GATE 4) | EM | — | — | AUTO |
| EXP-05 | **Receipt chase engine** — card txn posts → push/SMS/email to cardholder; follow-up interval; escalate after 3/5/10; quiet hours; never stops until matched | MD VIII.3, #293–296, BS §24 | PARTIAL · settings tab (`/settings?tab=chase`) + `chase_reminder_count` fields shown; **no sender, no scheduler, no SMS/push provider** | BK, AM, EM | C·Payables·Receipts (Missing tab) | +exp.missing_receipts, +em.my_receipts | AUTO |
| EXP-06 | **Card → cardholder assignments** | MD#354, BS §24 | PLANNED | BK, TA | C·Client settings·Cards | — | HUMAN |
| EXP-07 | **Receipt auto-approve thresholds** ($10/$25/$50/$100) | MD#297 | PARTIAL · setting only | CTL | Client settings | — | AUTO |
| EXP-08 | **Expense reports** — lines, approver queue, reimbursement batch | MD#299,307 | LIVE · `/expenses` | EM submits, DH approves, BK | C·Payables·Expenses | dh.approvals, +em.my_expenses | HUMAN |
| EXP-09 | **Mileage & per-diem policy** (IRS/GSA) | MD#304–305 | LIVE | EM | Expenses | — | AUTO |
| EXP-10 | **Expense policy compiler + out-of-policy detector (EC-14)** | MD#301,303 | LIVE · `/expenses/policy`, `out-of-policy-expense.ts` | CTL, DH | Expenses | am.exceptions | DETECT |
| EXP-11 | **Cash advances** | MD#306 | PLANNED | EM | Expenses | — | — |
| EXP-12 | **Spend analytics** (by cardholder/category/vendor) | MD#308 | PARTIAL · expense-by-vendor report | CFO, DH | C·Reports | — | — |

### 1.9 AR · invoicing · estimates · deposits · collections · cash application · portal pay
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| AR-01 | **Invoices** — create/edit/void/write-off, dims, sales tax, retainage | FPB-invoices | LIVE · `/invoices` | BK | C·Receivables·Invoices | +ar.to_bill | HUMAN |
| AR-02 | **Branded PDFs per entity** (5 styles) | MD#53 | LIVE · `entity-invoice-settings.tsx` | BK, TA | C·Client settings·Invoice branding | — | — |
| AR-03 | **Delivery** — email (Resend), share link, view tracking | FPB-invoices D4 | LIVE | BK | Invoices | — | AUTO |
| AR-04 | **Recurring invoices** | MD#54 | LIVE · mig 073 | BK | Invoices | +ar.to_bill | AUTO |
| AR-05 | **Credit memos** | MD#58 | LIVE | BK | Invoices | — | HUMAN |
| AR-06 | **Estimates/quotes → invoice** | MD#55 | LIVE · `/estimates` | BK | C·Receivables·Estimates | +ar.to_bill | HUMAN |
| AR-07 | **Customer deposits / retainers** (2420) | MD#60 | LIVE · `/customer-deposits` | BK | C·Receivables·Deposits | +ar.unapplied | HUMAN |
| AR-08 | **Progress / AIA G702/G703 billing in Books** | MD#56, CG#21 | PARTIAL · Projects app only | BK | C·Receivables·Invoices | — | PROPOSE |
| AR-09 | **Sales receipts (POS)** | MD#57 | PLANNED (cash_sale template) | BK | Invoices | — | — |
| AR-10 | **Stripe Pay Now** (card/ACH) → PAID → GL; two-layer fee model | MD G12.1, FPB-payments-fees | LIVE (test) · `/pay/[token]`, `/settings/payments` | customer, BK | C·Client settings·Online payments | — | AUTO |
| AR-11 | **AI cash application** — partial/lumped remittances to open invoices; apply on approval | MD G8 | LIVE · `/bank-feed?tab=apply-deposits`, `cash-application.ts` | BK | step 1 | +ar.unapplied | PROPOSE |
| AR-12 | **Collections worklist** — dunning drafts, promise-to-pay, DSO, risk | MD#63–64, FPB-invoices D6 | LIVE · `/collections` | BK, AM | C·Receivables·Collections | +ar.collections, cfo.kpis | PROPOSE |
| AR-13 | **Collections agent** — sends, handles replies, applies cash | CG#15 | PARTIAL · `collections-autopilot.ts` (drafts only) | BK | Collections | +ai.agent_gates | PROPOSE |
| AR-14 | **Late fees & reminders** | FPB-invoices D6 | PARTIAL · remind route | BK | Invoices | — | AUTO |
| AR-15 | **Customer statements + AR activity ledger** | MD#61 | LIVE | BK | C·Receivables·Customers | — | AUTO |
| AR-16 | **Unified AR aging incl. unbilled 1180; DSO** | MD#67,108 | LIVE · `ar-aging-merge.ts` | BK, CFO, OW | C·Reports | ow.glance, cfo.kpis | AUTO |
| AR-17 | **Customer master** — CRUD, dedupe/merge, credit/risk dossier | MD#72 | LIVE · `/customers` | BK | C·Receivables·Customers | — | PROPOSE |
| AR-18 | **Contract/SOW parse → invoice schedule + rev-rec setup** | MD G9c | PARTIAL (AI) | BK, CTL | Invoices | — | PROPOSE |
| AR-19 | **Customer portal** (magic link: invoices, balance, statement, pay) | MD#65 | LIVE · `/portal/customer` | customer | external | — | — |
| AR-20 | **Management-fee / service billing to related clients** (how a firm tenant charges its clients — NOT the retired chargeback engine) | CG#7, MD II.4 | PLANNED (internal invoices partially cover) | BK, CTL | tenant's own books · Receivables | +ar.to_bill | PROPOSE |

### 1.10 Revenue recognition · WIP · job cost · retainage · construction
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| REV-01 | **Rev-rec engine** — 9 methods; resolution per-job → revenue type → company → legacy | MD XI.2, CA§3 | LIVE · `/rev-rec`, `lib/rev-rec` | CTL, BK | C·Receivables·Revenue recognition | +rr.recognition | PROPOSE |
| REV-02 | **Rev-rec policy capture** at onboarding per company/stream (basis + method) | RRS §2 | LIVE · onboarding | CTL, TA | C·Client settings·Revenue policy | — | HUMAN |
| REV-03 | **Monthly recognition run** propose → approve (close step) | VIII.1, RRS §3 | LIVE run/preview; scheduled 1st-of-month PLANNED | CTL | step 4 | +rr.recognition, ctl.close_through | PROPOSE |
| REV-04 | **Deferred revenue 2410** on invoices for rev-rec jobs | CA§3 | LIVE | — | — | — | AUTO |
| REV-05 | **Unbilled accrual 1180** (self-reversing) | RRS §1 | LIVE · `/rev-rec?tab=accrual` | CTL | Rev rec | +rr.recognition | PROPOSE |
| REV-06 | **Deferred roll-forward, per-contract waterfall, method summary** | S49 | LIVE · rev-rec tabs rollforward/waterfall/methods | CTL, CFO | Rev rec | — | AUTO |
| REV-07 | **Revenue-not-recognized (EC-6) & cutoff (EC-12) detectors** | FPB-fce | LIVE | CTL | step 3 | ctl.exceptions | DETECT |
| REV-08 | **True-up forward vs retroactive** per company | VIII.1 | PLANNED | CTL | Revenue policy | — | HUMAN |
| REV-09 | **SSP / multi-element allocation** (ASC 606) | MD G9c | PLANNED | CTL | Rev rec | — | PROPOSE |
| REV-10 | **Jobs** — job P&L, cost codes, change orders | MD#252–259 | LIVE · `/jobs`, `/jobs/[id]` | BK, DH, CTL | C·Jobs & costing | dh.jobs | HUMAN |
| REV-11 | **Cost-code budgets, estimated vs actual** | MD#254,265, G6 | PARTIAL | DH, CTL | Jobs | dh.jobs | — |
| REV-12 | **WIP schedule** — over/under billing, EAC, ties to GL | MD#256, G6 | LIVE · `/jobs/wip` | CTL, CFO | C·Jobs & costing·WIP | +jobs.wip | PROPOSE |
| REV-13 | **EAC / cost-overrun prediction, profit fade** | CG#23 | PARTIAL · JOB_EAC narrative | CTL, DH | WIP | +jobs.wip | PROPOSE |
| REV-14 | **Retainage receivable/payable + release** | MD#260 | LIVE · `/retainage` (**no nav entry today**) | BK, CTL | C·Jobs & costing·Retainage | +jobs.retainage | HUMAN |
| REV-15 | **Projects ↔ Books event seam** (JOB_COST, JOB_BILLING, JOB_PROGRESS) | SC event contract v3 | LIVE | — | infra | — | AUTO |
| REV-16 | **COGS routing** (job-cost category → WIP / COGS clearing + job review queue) | VIII.1, BS §10 | PARTIAL (verify) | BK | step 1 | — | AUTO |
| REV-17 | **Lien waivers gated to payment** | CG#22 | PLANNED | BK, PC | Pay runs | +ap.holds | AUTO |
| REV-18 | **Subcontractor management** (agreements, pay apps; COI/W-9 exist) | MD#262 | PLANNED | BK | Vendors | — | — |
| REV-19 | **Field-system job sync** (ServiceTitan, BuilderTrend, RFMS…) → department | MD IX, CG#24 | PLANNED | TA | W·Settings·Integrations | pf.integrations | AUTO |

### 1.11 Inventory
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| INV-01 | **Items & movements** with approval | MD G11c | LIVE · `/inventory`, `/inventory/[id]` | BK, DH | C·Jobs & costing·Inventory | — | HUMAN |
| INV-02 | **FIFO / standard valuation + GL tie-out** | G11c | LIVE · `/inventory/valuation` | CTL | Inventory | ctl.close_through | AUTO |
| INV-03 | **Reorder scan** | S44 | PARTIAL (AI) | DH | Inventory | +inv.reorder | DETECT |
| INV-04 | **Average cost, landed cost, multi-warehouse, lots** | G11c, SC (MeritInventory reserved) | PLANNED | — | — | — | — |

### 1.12 Fixed assets · leases · prepaids · insurance · intangibles · equity
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| FA-01 | **Fixed-asset register** — SL/DDB/SYD/UoP, roll-forward, disposal gain/loss | MD#192–199 | LIVE · `/fixed-assets` (via `/assets` hub) | CTL, BK | C·Accounting·Assets & schedules | +ctl.schedules | PROPOSE |
| FA-02 | **Capex / prepaid / deferred predictor + capex invoice → asset** | MD II.5, G3 | LIVE (deterministic fallback) | BK | step 1 | — | PROPOSE |
| FA-03 | **Tax depreciation book** (MACRS, §179, bonus) | G2 | LIVE · `/tax-depreciation` | CTL | Assets & schedules | — | AUTO |
| FA-04 | **Monthly depreciation / amortization runs** | MD#127–128 | LIVE · schedule engine | CTL | step 4 | +ctl.schedules | PROPOSE |
| FA-05 | **Asset transfer between clients; impairment** | MD#192–199 | PARTIAL (impairment on intangibles) | CTL | Assets | — | HUMAN |
| FA-06 | **Physical asset tracking** (barcode, check-out, maintenance) | MD Cat 15 | PLANNED (future suite module) | — | — | — | — |
| FA-07 | **ASC 842 leases** — parse, commence, period, CPI, modify, terminate | MD G9c | LIVE · `/leases` | CTL | Assets & schedules | +ctl.schedules | PROPOSE |
| FA-08 | **Prepaids** — parse, schedule, post by role | G2 | LIVE · `/prepaids` | BK, CTL | Assets & schedules | +ctl.schedules | PROPOSE |
| FA-09 | **Insurance register** → prepaid amortization | mig 132 | LIVE · `/insurance` | CTL | Assets & schedules | +cash.obligations | PROPOSE |
| FA-10 | **Intangibles** — amortize, impair | S45 | LIVE · `/intangibles` | CTL | Assets & schedules | +ctl.schedules | PROPOSE |
| FA-11 | **Equity schedule / cap table** (holders, classes, contributions, distributions) | BS §10, MD#209 | PARTIAL · equity table report, onboarding equity section | CTL, OW | C·Accounting | — | HUMAN |

### 1.13 Debt · covenants · borrowing base · lender reporting
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| DEBT-01 | **Debt register** — origination JE, P&I split, payoff, refinance, variable rate, schedule | BS §10, MD#208 | LIVE · `/debt` | CTL, CFO | C·Banking & cash·Debt & covenants | +debt.maturities | PROPOSE |
| DEBT-02 | **Existing-loan mode** (no origination JE) | S50 | LIVE | CTL | Debt | — | — |
| DEBT-03 | **Loan document parse** → loan + covenants | NS §6.6 | PARTIAL (AI) · `debt-parse-review.tsx`, `covenant-parse-review.tsx` | CTL | Debt | — | PROPOSE |
| DEBT-04 | **Covenant monitor** — DSCR/FCCR/leverage from the ledger, headroom, projected breach date | mig 078 | LIVE · `/debt?tab=covenants`, `lib/covenants` | CFO, CTL, OW | Debt (Covenants tab) | ow.covenants, cfo.covenants | AUTO |
| DEBT-05 | **Compliance certificate** generation | S44 | LIVE | CFO | Debt | cfo.covenants | PROPOSE |
| DEBT-06 | **Covenant drift (EC-11)** | FPB-fce | PARTIAL · COVENANT_DRIFT narrative | CFO | Debt | cfo.covenants | DETECT |
| DEBT-07 | **Borrowing base** calculator + certificate (AR/inventory eligibility) | BS §25 #6, NS §6.6 | LIVE · `/borrowing-base`, `lib/borrowing-base` | CFO, CTL | Debt (Borrowing base tab) | +debt.borrowing_base | PROPOSE |
| DEBT-08 | **Lender reporting calendar** — certs, BBCs, financials due per lender | CG#17 | PLANNED | CFO, CTL | Debt (Lender reporting tab) | +debt.lender_calendar | AUTO |
| DEBT-09 | **Scheduled lender/investor packs; auto-send certificates** (human-approved send) | CG#17 (market white space) | PARTIAL · board package + certs, no schedule | CFO | Reports·Board & lender packs | +rpt.packs | PROPOSE |
| DEBT-10 | **Intercompany loans** — request, 3-tier approval, promissory note + resolution docs, e-sign, interest both sides | BS §10, MD#203–207, CG#7 | PLANNED | CFO, CTL, OW | tenant's own books / X | — | PROPOSE |
| DEBT-11 | **Lines of credit** — draws/paydowns, availability | PE | PARTIAL · loan draw/payment templates | CFO | Debt | +debt.borrowing_base | HUMAN |
| DEBT-12 | **Covenants measured on a group** (lender tests a combined group) | IA M-6 + BS §10 | PLANNED (covenant borrower = client or group) | CFO | X | cfo.covenants | AUTO |
| DEBT-13 | **Lender portal** — read-only access to certificates and packs | NS §3, CG#17 | PLANNED | LV | external portal | — | — |

### 1.14 Cash · treasury · forecasting · obligations · subscriptions
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| CASH-01 | **Cash position across clients** with min-cash status | MD#83,210 | LIVE · `/cash`, `/api/cash` (min-cash status) | CFO, OW, CTL | C·Banking & cash·Cash; W·Insights | ow.glance, cfo.kpis | AUTO |
| CASH-02 | **Daily cash report** (opening/in/out/closing vs minimum) | BS §11 | PARTIAL | CFO | Cash | +cash.min_cash | AUTO |
| CASH-03 | **Min-cash alerts + transfer recommendations** | MD#211–212, BS §11 | PLANNED | CFO, OW | Cash | +cash.min_cash | PROPOSE |
| CASH-04 | **13-week direct cash forecast** | MD#213 | LIVE · `/cash?tab=forecast`, `lib/forecast` | CFO | Cash (Forecast tab) | cfo.forecast | AUTO |
| CASH-05 | **Forecast layers** actual / committed / AI-estimated; confidence bands; AR payment patterns; seasonality | MD#214–216, CG#13 | PARTIAL | CFO | Forecast | cfo.forecast | PROPOSE |
| CASH-06 | **Cash scenarios** (toggles + NL) | MD#217–219 | PARTIAL · FP&A what-if, heuristic NL | CFO | Forecast | +fpa.scenarios | PROPOSE |
| CASH-07 | **Forecast-vs-actual accuracy tracking** | MD#220 | PLANNED | CFO | Forecast | cfo.forecast | AUTO |
| CASH-08 | **Renewals & obligations calendar** (leases, debt, insurance, subscriptions, contracts) | S45 | LIVE · `/obligations`, `lib/cash/obligations.ts` | CFO, OW, CTL | Banking & cash·Renewals & obligations | +cash.obligations | AUTO |
| CASH-09 | **Subscriptions** — run-rate, creep, renewals, keep/cancel | BS §25 #7 | LIVE · `/subscriptions` | CTL, OW | Banking & cash·Subscriptions | +cash.subscriptions | DETECT |
| CASH-10 | **Balance trend + obligation bucketing** (7/30/60/90) | S50 | LIVE · `lib/cash/trend.ts` | CFO | Cash | ow.glance | AUTO |
| CASH-11 | **Intercompany cash transfers / sweeps** (recommend + record) | BS §11 | PLANNED | CFO | X / own books | +cash.min_cash | PROPOSE |

### 1.15 Payroll & the HR/payroll role
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| PRL-01 | **Payroll register import** CSV/XLSX → balanced JE (no AI needed) | BS §10, mig 136 | LIVE · `/payroll`, `lib/payroll/register-*` | HR | C·Payables·Payroll | hr.tied | AUTO |
| PRL-02 | **AI payroll register parse** | AI catalog | PARTIAL (AI) | HR | Payroll | — | PROPOSE |
| PRL-03 | **Employees, pay schedules, register mappings** | FPB-payroll | LIVE | HR | Payroll | hr.upcoming | HUMAN |
| PRL-04 | **Embedded payroll run** (provider-agnostic engine; Check/Gusto) run → release → post | MD G12.3, FPB-payroll | STUB · mock engine labelled "estimate"; provider not chosen | HR, CFO | Payroll | hr.upcoming, cfo.release | HUMAN |
| PRL-05 | **Payroll release SoD** (releaser ≠ approver) | S50 | LIVE | CFO | release | cfo.release | AUTO |
| PRL-06 | **Liability remittance** (clears tax/benefit payables) | S50 | LIVE | HR | Payroll | hr.remit | HUMAN |
| PRL-07 | **Payroll liability tie to $0** (close check) | VIII.5 | LIVE/PARTIAL | HR, BK | step 3 | ctl.close_through | AUTO |
| PRL-08 | **W-2, filings, direct deposit, garnishments, new-hire reports** (via provider) | FPB-payroll | PLANNED | HR | Payroll | — | — |
| PRL-09 | **Payroll visibility** grouped/ungrouped/none per membership | IA M-3 | PLANNED | TA | membership | — | — |
| PRL-10 | **Payroll funding check** (funding account vs net pay) | IA §4.9 | PLANNED | HR, CFO | Payroll | hr.upcoming | AUTO |
| PRL-11 | **Certified / union payroll** | CG#25 | PLANNED (provider) | HR | — | — | — |

### 1.16 Tax
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| TAX-01 | **Sales-tax rate engine** (effective-dated); Avalara/TaxJar adapter | G11d, mig 144 | LIVE engine · STUB provider | BK | C·Client settings·Sales tax | — | AUTO |
| TAX-02 | **Sales-tax return worksheet + GL tie-out + filing calendar** | S44 | LIVE · `/tax/sales-tax` | BK, CTL | C·Accounting·Tax | bk.agenda, +tax.filings_due | PROPOSE |
| TAX-03 | **Nexus tripwire (EC-7)** | FPB-fce | LIVE | CTL | Tax | +tax.nexus | DETECT |
| TAX-04 | **Sales-tax filing & remittance via provider** | G11d | PLANNED | BK | Tax | — | — |
| TAX-05 | **1099 NEC/MISC** — classify, W-9 gaps, Copy B PDFs, FIRE file | MD#49–50 | PARTIAL (needs IRS TCC) · `/compliance-1099` | BK | Tax (1099 tab) | +tax.1099 | PROPOSE |
| TAX-06 | **1099 tracking** ($600+ across clients, TIN masked) | BS §14 | LIVE | BK | Tax | +tax.1099 | AUTO |
| TAX-07 | **Book-to-tax M-1/M-3** | mig 077 | LIVE · `/book-to-tax` | CTL | Tax | — | PROPOSE |
| TAX-08 | **ASC 740 provision** (current + deferred, rollforward) | mig 091 | LIVE · `/tax-provision` | CTL | Tax | — | PROPOSE |
| TAX-09 | **1120-style return package + PDF** | S45 | LIVE · `/tax-package` | CTL, AU (external CPA) | Tax | — | AUTO |
| TAX-10 | **Regulatory filing grid** (sales tax, 940/941, state withholding/UI, property tax; filed/due/overdue; penalty exposure; filing archive) | BS §13, MD#147–152 | PARTIAL · `/compliance` center | CTL, BK, CFO | C·Controls·Compliance | +tax.filings_due | AUTO |
| TAX-11 | **Tax notice / K-1 ingestion** | MD G4 | PLANNED | CTL | Documents | — | PROPOSE |
| TAX-12 | **R&D credit / multistate flags** | MD G9c | PLANNED | CTL | Tax | — | DETECT |

### 1.17 FP&A
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| FPA-01 | **Budgets** by account/client/department/period; entry grid; import | MD#266,269 | LIVE · `/budgets` | CFO, FD, DH | C·Reports & planning·Budgets | fd.bva, dh.bva | HUMAN |
| FPA-02 | **Budget vs actual** (favorable/unfavorable color) | MD#113 | LIVE | CFO, FD, DH, OW | Budgets / Reports | cfo.kpis, fd.bva | AUTO |
| FPA-03 | **Driver-based budgeting** | MD#275 | LIVE · `/budgets?tab=drivers` | CFO, FD | Budgets | — | PROPOSE |
| FPA-04 | **Rolling reforecast** | MD#273 | LIVE · `/budgets?tab=reforecast` | CFO, FD | Budgets | +fpa.reforecast | PROPOSE |
| FPA-05 | **Scenarios / what-if / sensitivity / NL scenarios** | MD#280–282, BS §23 | LIVE · `/fpna` (heuristic parser works without AI) | CFO, OW | FP&A | +fpa.scenarios | PROPOSE |
| FPA-06 | **Budget cycle** — top-down + bottom-up, department-head submissions, review | MD#267–268,271 | PLANNED | DH, FD, CFO | Budgets (Cycle tab) | +fpa.budget_cycle | HUMAN |
| FPA-07 | **Budget versions & audit** | MD#272 | PLANNED | CFO | Budgets | — | — |
| FPA-08 | **3-statement pro forma** | MD#276 | PLANNED | CFO | FP&A | — | AUTO |
| FPA-09 | **Workforce / headcount planning** | MD#283–284 | PLANNED | CFO, HR | FP&A | — | HUMAN |
| FPA-10 | **Flux / variance narrative** (deterministic drivers; AI only words them) | MD#120, M7 | PARTIAL · `narrative-panel.tsx` "Computed (AI unavailable)" | CFO, CTL, OW | Reports | cfo.compare, +fpa.flux | PROPOSE |
| FPA-11 | **Profitability by client** | S42 | LIVE · `/profitability` | CFO, OW, AM | W·Insights | ow.clients_compare, cfo.compare | AUTO |
| FPA-12 | **Profitability by department / job / customer / class** inside a client | MD#88–90,106 | PARTIAL · reports | CFO, FD, DH | C·Reports & planning | dh.bva | AUTO |
| FPA-13 | **Custom KPIs & role KPI dashboards** | MD#116,285–286, BS §23 | PLANNED · delivered by IA widget registry | all | homes | cfo.kpis | — |
| FPA-14 | **Board package** — MD&A, KPI trend strip, DSO/DPO, PDF/XLSX | MD#117,287 | LIVE · `/board-package` | CFO, OW | Reports & planning·Board & lender packs | +rpt.packs | PROPOSE |
| FPA-15 | **Consolidated budget across a group** with eliminations | BS §23 | PLANNED | CFO | X | — | AUTO |
| FPA-16 | **Ledger formulas in Excel / Sheets** | CG#29 | PLANNED | CFO, FD | add-in | — | — |
| FPA-17 | **Revenue forecasting** (payment patterns, pipeline) | BS §23 | PLANNED | CFO | FP&A | — | PROPOSE |
| FPA-18 | **Diligence / exit package** (normalized EBITDA bridge, source-linked) | MD G9d | PLANNED | OW, CFO | X / Reports | — | PROPOSE |
| FPA-19 | **Opt-in cross-tenant benchmarking** | MD G9d | PLANNED | OW, CFO | Reports | — | AUTO |

### 1.18 Reporting · report packs · NL reports
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| RPT-01 | **Core statements** — P&L, BS, TB, cash flow (indirect + direct), changes in equity | MD#86–101, BS §20 | LIVE · `/reports` | all finance | C·Reports & planning·Reports; X | — | AUTO |
| RPT-02 | **P&L variants** — by month/class/department, comparatives, % of income | MD#87–95 | LIVE | CFO, CTL | Reports | — | AUTO |
| RPT-03 | **GL detail, transaction list, drill summary → transaction → source doc** | MD#102–104,115 | LIVE · `gl-drill-down.tsx` | all | Reports | au.statements | — |
| RPT-04 | **Subledger reports** — AR/AP aging, open items, balances, sales by customer, expense by vendor, 1099 summary, sales-tax summary | MD#107–111 | LIVE | BK, CFO | Reports | — | AUTO |
| RPT-05 | **Operational reports** — debt schedule, equity table, job cost/profitability, WIP | MD#106,191 | LIVE | CTL, DH | Reports | — | AUTO |
| RPT-06 | **Export PDF / CSV / XLSX** | MD#118 | LIVE · `lib/reports/export` | all | Reports | — | — |
| RPT-07 | **Saved report views** | mig 138 | LIVE | all | Reports | — | — |
| RPT-08 | **Report packs + scheduled email delivery** | MD#119, CG#17 | PARTIAL · `/api/reports/packs/run-scheduled` (no scheduler) | CFO, CTL, AM | Reports & planning·Packs | +rpt.packs | AUTO |
| RPT-09 | **NL report compiler** | M8 | PARTIAL (AI) · `lib/reports/compiler` | CFO, CTL | Reports + ⌘K | — | PROPOSE |
| RPT-10 | **Custom report writer** | MD#114, BS §20 | PLANNED | CTL, CFO | Reports | — | HUMAN |
| RPT-11 | **Search** (Postgres full-text) over ledger and documents | M13, mig 095 | LIVE · `/search` | all | ⌘K / top bar | — | — |
| RPT-12 | **Semantic search + cited knowledge over contracts/policies** | M13 | PLANNED (deferred: needs embeddings) | all | ⌘K | — | — |
| RPT-13 | **Client management packet** with client branding | MD#331–332 | PARTIAL | BK, AM | C·Home·Close | ow.books_status | PROPOSE |
| RPT-14 | **Explain-this-object** (JE, bill, invoice, rec item, payment) | M7 | PARTIAL · `explain-panel.tsx`, `/api/explain` | all | drawers | — | PROPOSE |

### 1.19 Consolidation · intercompany · internal invoices
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| CON-01 | **Consolidated statements** — ownership %, NCI, FULL/EQUITY/NONE | MD G11a, mig 076 | LIVE · `/consolidation` | CFO, CTL, OW (grant) | X | ow.consolidated, cfo.consolidated | AUTO |
| CON-02 | **Eliminations as explicit lines; elimination drill-down** | CG#16 | PARTIAL | CTL | X | ctl.intercompany | AUTO |
| CON-03 | **FX translation ASC 830** | mig 133 | LIVE | CTL | X | — | AUTO |
| CON-04 | **Intercompany matching & pair balances (EC-3)** | FPB-fce | LIVE · `intercompany-balance.ts` | CTL | X + C·Accounting·Intercompany | ctl.intercompany | DETECT |
| CON-05 | **Intercompany due-to / due-from** (cross-client, real cash) | mig 035 | LIVE · `/consolidation?tab=intercompany` | BK, CTL | C·Accounting·Intercompany | ctl.intercompany | HUMAN |
| CON-06 | **Internal invoices** (inter-department / intercompany): draft → sent → receiving dept head approves → booked; revenue vs cost-transfer; integrity check | MD II.4, VIII.6 | LIVE · `/internal-invoices` | BK issues, DH approves | C·Accounting·Internal invoices | dh.approvals, +ic.internal_invoices | HUMAN |
| CON-07 | **Named consolidation groups** (consolidated / combined) + grants | IA M-6, OD | PLANNED | CTL, TA | W·Consolidations | ow.consolidated | — |
| CON-08 | **Multi-level trees** (funds → SPEs → clients) | CG#16 | PARTIAL (verify engine walks `entity_ownership`) | CTL | X | — | AUTO |
| CON-09 | **Group-level top-side adjustments** | IA §1.1 | PLANNED | CTL | X | — | HUMAN |
| CON-10 | **Combined lender / group pack** | CG#17 | PARTIAL | CFO | X | +rpt.packs | PROPOSE |

### 1.20 Controls · exceptions · approvals · SOX · audit · PBC · AI decision log
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| CTRL-01 | **Exception library** — 12 deterministic detectors (dup payment, missed accrual, intercompany, uncategorized, revenue not recognized, nexus, anomalous JE, cutoff, cash application, bill anomaly, out-of-policy, payment fraud) | FPB-fce | LIVE · `lib/controls/*`, `/inbox?tab=exceptions` | CTL, AM, BK | C·Home step 3; W·Work·Exceptions | am.exceptions, ctl.exceptions | DETECT |
| CTRL-02 | **Remaining classes** EC-5 unreconciled aging, EC-8 1099 gaps, EC-9 book-tax, EC-11 covenant drift, EC-13 re-expensed settlement | FPB-fce | PARTIAL | CTL | step 3 | ctl.exceptions | DETECT |
| CTRL-03 | **Action Inbox** — approvals, exceptions, alerts, drafts; snooze; keyboard nav | S45 | LIVE · `/inbox` | all internal | W·Home·Inbox; C·Home | am.review_queue, ow.decisions | — |
| CTRL-04 | **Approval enforcement everywhere** — one materiality policy for people AND agents; routing by entry source (agent/API/UI) | CG#4, VIII.7 | PARTIAL | TA, CTL | W·Settings·Approval workflows | — | AUTO |
| CTRL-05 | **Compliance & controls / SOX command center** | S45 | LIVE · `/compliance` | CTL | C·Controls·Compliance | +ctl.sox | — |
| CTRL-06 | **Control testing evidence** | finance SOX | PARTIAL | CTL, AU | Compliance | +ctl.sox | HUMAN |
| CTRL-07 | **Audit trail search** (`action_log`, `audit_log`) | MD#21,414 | LIVE · `/audit` | AU, CTL | C·Controls·Audit trail | au.audit_trail | — |
| CTRL-08 | **AI Decision Log** (inputs, confidence, reasoning, rejected alternative, disposition) | MD G3d, VIII.7 | LIVE · `/ai-decisions` | CTL, AM | C·Controls·AI decision log | +ctl.ai_review | AUTO |
| CTRL-09 | **Autonomy dial per feature + kill switch** | M10, mig 075 | LIVE · `/settings/autonomy` | TA, CTL | W·Settings·AI autonomy | bk.done_for_you | — |
| CTRL-10 | **Plain-English custom checks → deterministic rules** | CG#10 | PLANNED | CTL | Compliance | ctl.exceptions | DETECT |
| CTRL-11 | **Watch rules & proactive alerts** ("tell me when Heartland cash < next payroll") via email/Slack/Teams | CG#3, MD G9b | PLANNED | OW, CFO, CTL, AM | W·Settings·Alerts | +alerts.watch | DETECT |
| CTRL-12 | **Audit agents** (agents checking agents vs policy → monthly control report) | CG#18 | PLANNED | CTL | Compliance | +ctl.ai_review | DETECT |
| CTRL-13 | **External auditor access + PBC** | mig 145 | LIVE · `/pbc` | AU, CTL | C·Controls·Requests (PBC) | au.pbc | HUMAN |
| CTRL-14 | **Documents center + attachments + source retention** | mig 090, 112 | LIVE · `/documents`, AttachmentsPanel | all | C·Accounting·Documents | — | — |
| CTRL-15 | **Access review** (stale access, expired auditors) | IA §2.6 | PLANNED | TA | W·Team·Access | ta.access_review | DETECT |
| CTRL-16 | **AI eval suite on every release** | CG#19 | PLANNED | PA | P·Health | pf.ai | AUTO |

### 1.21 Vendor & customer master / compliance
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| VND-01 | **Vendor master** — vendor 360, ledger, duplicate detection | MD#239 | LIVE · `/vendors` | BK, DE | C·Payables·Vendors | — | HUMAN |
| VND-02 | **Vendor compliance docs** W-9 / GL COI / WC COI / WC exemption + AI parse + risk engine | MD#240–243,248 | LIVE · `/vendor-compliance` | BK, AM | C·Payables·Vendor compliance | +vc.expiring | PROPOSE |
| VND-03 | **Auto payment hold + overrides** (one-time / temporary / permanent, audited, AM+ only) | MD#244,249–250 | LIVE | AM | Vendor compliance | +ap.holds | AUTO |
| VND-04 | **Outbound auto-chase** (2 wks from 60 days, then weekly) | MD#245, VIII.4, NS §6.5 | PARTIAL · status/chase UI; no scheduled sender | BK | Vendor compliance | +vc.expiring | AUTO |
| VND-05 | **One document covers many clients** (tenant-level outreach) | MD#246 | PARTIAL | BK | Vendor compliance | — | AUTO |
| VND-06 | **Vendor portal** (magic link: W-9/COI/banking → PENDING review) | MD#247, mig 142 | LIVE · `/portal/vendor` | vendor, BK | external + Vendor compliance | +vc.portal_uploads | HUMAN |
| VND-07 | **Provisional vendors from Projects** vetted by Books | SC Rule C | PARTIAL | BK | Vendors | +vc.expiring | HUMAN |
| VND-08 | **Related-client customer flag** (customer record that is another client) | IA M-2 | PLANNED (rename `is_portfolio_company`) | CTL | Customers | — | — |
(Customer master = AR-17; customer portal = AR-19.)

### 1.22 Portals & requests
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| PRT-01 | **Client requests** — transaction questions with suggested answers, document asks, approvals; magic link; reminders; blocking-close flag | IA M-7, MD#324–326 | PLANNED | BK asks, CC answers | C·Home·Requests; CC home | bk.requests_out, am.requests_stale, cc home | PROPOSE |
| PRT-02 | **One Requests UI** over client requests + PBC (+ receipt chase, vendor chase — see G2) | IA §1.5 | PLANNED | BK, AM | Requests | — | — |
| PRT-03 | **Client read-only statements / packet view** | IA §2.4 | PARTIAL (owner role) | OW, CC | C·Reports | ow.books_status | — |
| PRT-04 | **Employee / cardholder surface** (my receipts, my expenses; mobile) | MD VIII.3, Cat 20 | PLANNED | EM | EM home | +em.my_receipts, +em.my_expenses | — |
(Customer portal = AR-19 · vendor portal = VND-06 · auditor = CTRL-13 · lender portal = DEBT-13.)

### 1.23 Onboarding · migration · imports
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| ONB-01 | **Front door, self-serve tenant, wizard, readiness, tour** | MD II.7, FPB-onboarding | LIVE · `/onboarding*`, `/setup` | TA, BK | first-run | — | PROPOSE |
| ONB-02 | **Drop-anything intake** (classify any document) | FPB-onboarding | PARTIAL (AI) | BK | onboarding | — | PROPOSE |
| ONB-03 | **TB import** (XLSX/QBO/AI) + AR/AP/WIP/equity/formation imports | MD#382 | LIVE | BK | onboarding | — | PROPOSE |
| ONB-04 | **Historical conversion** with tie-out gate + balanced go-live post | S44 | LIVE · `/onboarding/conversion` | BK, CTL | C·Client settings·Data import & conversion | am.onboarding | PROPOSE |
| ONB-05 | **Bulk client onboarding + tracker** ("Control Tower") | S48 | LIVE · `/onboarding/portfolio` (rename) | AM, TA | W·Clients·Add clients / Onboarding tracker | am.onboarding | — |
| ONB-06 | **Generic CSV import** | — | LIVE · `/import` | BK | Data import | — | — |
| ONB-07 | **QBO / Xero / Sage direct pull** (migration only) | MD IX | PARTIAL · QBO OAuth needs creds; Xero/Sage mock | BK | Data import | — | AUTO |
| ONB-08 | **Departments + internal-charge method step with AI assist** | MD II.3 | LIVE | TA | onboarding | — | PROPOSE |
| ONB-09 | **Per-module onboarding reps + core-master import assignment + dependency enforcement** | SC identity §6a | PARTIAL · "Owns onboarding" designation | TA, PA | W·Clients | am.onboarding | — |
| ONB-10 | **Platform provisioning of tenants** (org, entitlements, COA seed, periods, first admin) | SC identity §6–7, OD | PLANNED (self-serve only today) | PA | P·Tenants·Provision | pf.funnel | HUMAN |
| ONB-11 | **Tenant lifecycle / onboarding funnel** | IA M-1 | PLANNED | PA | P·Tenants | pf.funnel | AUTO |
| ONB-12 | **Sandbox tenant; tenant reset / export** | MD IV.7 | LIVE · `/sandbox`, tenant-reset | PA, TA | P·Tenants (detail) | — | — |

### 1.24 Integrations
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| INT-01 | **Scheduler / cron** — agents, report packs, nightly detectors, daily feed pull, rev-rec run on the 1st, compliance + receipt chase, reminders | MD Cat 22, CG#2 | PLANNED (cron-ready routes exist; no scheduler) | PA | infra | pf.errors | AUTO |
| INT-02 | **Stripe Connect** (Express accounts, destination charges) | MD G12.1 | LIVE (test) | TA | Client settings·Online payments | pf.integrations | — |
| INT-03 | **Provider-connection registry + Vault secrets** | mig 041 | LIVE | — | infra | — | — |
| INT-04 | **Resend email** | — | LIVE | — | infra | — | — |
| INT-05 | **Clerk auth** | — | LIVE (dev instance) | — | infra | — | — |
| INT-06 | **Azure Document Intelligence OCR** | MD G4 | PARTIAL | — | infra | — | — |
| INT-07 | **M365 / Graph mailbox ingestion** (per-tenant mailbox list) | MD G4, IX | PLANNED (blocked on Azure creds) | TA | W·Settings·Integrations | bk.feeds | AUTO |
| INT-08 | **Payroll provider** (Check / Gusto Embedded) | MD G12.3 | STUB | TA | Integrations | pf.integrations | — |
| INT-09 | **Avalara / TaxJar** | G11d | STUB | TA | Integrations | — | — |
| INT-10 | **AP disbursement provider** (Melio-style / Modern Treasury, bring-your-own-bank) | MD G12.2 | STUB | TA | Integrations | — | — |
| INT-11 | **ERP / field-system catalog** (~25: ServiceTitan, Procore, BuilderTrend, RFMS, Simpro, FieldEdge, Innergy, Jobber) | MD IX | PLANNED · `/integrations/erp` catalog page | TA | Integrations | pf.integrations | AUTO |
| INT-12 | **MCP server** (read + role-scoped writes as proposals) | CG#6 | PLANNED | TA | Integrations | — | PROPOSE |
| INT-13 | **Slack / Teams / SMS / push notifications** | CG#3, MD VIII.3 | PLANNED | — | infra | — | AUTO |
| INT-14 | **Sentry / error observability** (`app_error_log`) | mig 146 | LIVE (Sentry optional) | PA | P·Health·Errors | pf.errors | AUTO |
(Plaid = BNK-01 · Ramp = BNK-08 · migration connectors = ONB-07 · Projects seam = REV-15.)

### 1.25 AI · agents · autonomy · ⌘K
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| AI-01 | **Core AI gateway** — metering, nested budgets, caps (Core-owned) | MD G1, I.3 | LIVE (Anthropic org disabled) | PA | P·Health·AI gateway | pf.ai | AUTO |
| AI-02 | **Drop-and-parse everywhere** (bills, receipts, statements, contracts, assets, leases, debt, covenants, insurance, prepaids, subscriptions, W-9/COI, payroll, policies, onboarding docs) | M1 | PARTIAL (AI dark; review UIs LIVE) | BK, CTL | each module | — | PROPOSE |
| AI-03 | **Clarify before booking** (one disambiguating question) | MD II.5 | PARTIAL | BK | review panels | bk.ai_judgment | PROPOSE |
| AI-04 | **⌘K command bar** — navigate / analyze / process lanes | FPB-nl-copilot | LIVE (heuristic without AI) · `components/nl/*` | all | global | — | PROPOSE |
| AI-05 | **FP&A copilot** — NL → allowlisted metric catalog, read-only, abstains | FPB-nl-copilot | LIVE | CFO, OW | ⌘K / FP&A | — | — |
| AI-06 | **NL processing lanes** (categorize, draft bill, draft invoice) | FPB-nl-copilot | PARTIAL (AI) | BK | ⌘K | — | PROPOSE |
| AI-07 | **Agent runner** AUTO / PROPOSE / HUMAN_GATE + recipes (AP intake, procure-to-pay, pay run, close run, order-to-cash, collections) | M9, mig 096 | PARTIAL · `lib/agents/*`, `/agents` | BK, AM, CTL | W·Work·Agents; C·Home | bk.done_for_you, +ai.agent_gates | PROPOSE |
| AI-08 | **Learning** — vendor memory + `learned_preferences` (proposals only) | M14, mig 097 | LIVE | BK | W·Settings (learned) | bk.done_for_you | AUTO |
| AI-09 | **Narratives** — flux, board MD&A, rec memo, covenant drift, customer risk, EAC | M7 | PARTIAL | CFO, CTL | per report | +fpa.flux | PROPOSE |
| AI-10 | **Shared business context per client** (what each entity does), read by every agent | CG#20 | PLANNED | AM | C·Client settings·Client profile | — | — |
| AI-11 | **Proactive CFO feed** (DSO drift, margin erosion, spend creep, vendor price rises) | MD G9b | PLANNED | CFO, OW | homes | +alerts.watch | DETECT |
| AI-12 | **"Why" forensics** traced to transactions | MD G9b | PARTIAL · analytical lane | CFO, OW | ⌘K | — | — |
| AI-13 | **Voice** | CG#32 | PLANNED | OW, CFO | — | — | — |
| AI-14 | **AI usage & cost per tenant / client / feature** | MD#356,368,433 | PARTIAL · platform metrics only | PA, TA | P·Health; W·Settings·Plan & billing | pf.ai, +ta.ai_usage | AUTO |
| AI-15 | **AI-down honesty** ("AI paused — rules and vendor memory still coding") | S48 | LIVE · `ai-unavailable-notice.tsx` | all | everywhere | — | — |

### 1.26 Admin · RBAC · team · billing · platform
| ID | Capability — definition | Source | Status · carry-forward | Roles | IA home | Widgets | Auto |
|---|---|---|---|---|---|---|---|
| ADM-01 | **System roles + custom roles + cell overrides; role-filtered sidebar; page guards** | mig 130 | LIVE · `/settings/roles`, `lib/rbac` | TA | W·Settings·Roles & permissions | — | — |
| ADM-02 | **Role rename + new system roles** (tenant_admin, controller, finance_director, bookkeeper, payments_clerk, data_entry, owner, hr_payroll, department_head, external_auditor, client_contact, view_only) | IA §2.5 | PLANNED | TA | — | — | — |
| ADM-03 | **Memberships as the authority; `client_scope` all/assigned** | IA M-3, R5 | PARTIAL · memberships exist; authority still `employees.role` | TA | — | — | — |
| ADM-04 | **Client-scoped RLS** `can_access_location()` | IA M-4, R1 | PLANNED (**must fix**: client access is UI-only today) | — | infra | — | AUTO |
| ADM-05 | **Client assignments** — capacity × function, effective-dated, vacation cover | IA M-5 | PARTIAL · `core.practice_assignments` | AM | W·Team·Assignments | am.close_grid | HUMAN |
| ADM-06 | **Bounded delegation** (accounting manager grants within own scope) | IA §2.6 | PLANNED | AM | W·Team·Access | — | HUMAN |
| ADM-07 | **Team members, invites, deactivate, lifecycle sync** | MD#344–345 | LIVE · `/team` | TA, AM | W·Team·Staff & capacity | ta.access | HUMAN |
| ADM-08 | **Team performance KPIs** (quality-gated, hard to game) | FPB-team-performance, mig 074 | LIVE · `/team` performance panel | AM | W·Insights·Team performance | am.quality | AUTO |
| ADM-09 | **Staff capacity & reassignment** | IA §4.2 | PLANNED | AM | W·Team | am.capacity | HUMAN |
| ADM-10 | **Context switcher** (platform / workspace / client / own books / consolidated / support), ⌘J | IA §3 | PLANNED · today header company picker + `plane-switcher.tsx` | all | shell | — | — |
| ADM-11 | **Dashboard layouts** — 3 layers, widget registry, edit mode, publish, versions | IA §5, OD | PLANNED | PA, TA, all | homes | all | — |
| ADM-12 | **Plan & billing** — $99/$59 per company; firm $499 + wholesale; live Stripe charging | Marketing-Pricing, mig 131 | PARTIAL (computed MRR) · charging STUB · `/settings/billing` | TA, PA | W·Settings·Plan & billing; P·Revenue | ta.billing, pf.billing | AUTO |
| ADM-13 | **Entitlements / module selection per tenant** (suite modules) | SC identity §4, BS §25 #11 | PARTIAL · `entitlements` jsonb; console placeholder | PA | P·Tenants (detail) | — | — |
| ADM-14 | **Operator console** — tenants, seats, AI cost, storage, fee revenue, ops health | S48 | LIVE · `/platform` | PA | P·Home | pf.* | AUTO |
| ADM-15 | **Platform roles + consented, time-boxed support access + red-band session + tenant-visible log** | IA M-9, R7 | PLANNED | PA, PS, TA | P·Support; W·Settings | pf.support, ta.support | HUMAN |
| ADM-16 | **MFA / SSO / passkeys / session policy / IP allowlist / lockout** | MD#403,409–411, CG#28 | PLANNED | TA | W·Settings·Security | ta.access | — |
| ADM-17 | **White-label theming per tenant** (logo, colors, domain) | MD G10 | PARTIAL · invoice branding per client only | TA, PA | W·Settings·Tenant settings | — | — |
| ADM-18 | **Tenant settings** — org, receipt chase, AI, routing, rev-rec policy, sales tax, branding, learned prefs, clients, danger zone | BS §24 | LIVE · `/settings` (to split tenant vs client) | TA | W·Settings / C·Client settings | — | — |
| ADM-19 | **Tenant type firm/company + lifecycle** | IA M-1, OD | PLANNED | PA | — | — | — |
| ADM-20 | **Per-page help, notifications bell, global search palette** | S47 | LIVE · `lib/help`, `notifications-bell.tsx`, `search-palette.tsx` | all | shell | — | — |
| ADM-21 | **Platform templates** (dashboard, role, COA, help) | IA §3.4 | PLANNED | PA | P·Defaults | — | — |
| ADM-22 | **Practice tasks / workflow templates** beyond close (client tasks, due dates) | MD#329–330 | PARTIAL · close checklists | AM | W·Work | bk.agenda | HUMAN |
| ADM-23 | **Practice economics** — effort and profitability per client, scope creep, realization (no time tracking: effort comes from activity counts × time standards) | discovery firm-partner B6–B9 | PLANNED | AM, OW (firm) | W·Insights | +am.client_economics | AUTO |
| ADM-24 | **Suggest-a-feature; dark/light toggle** | MD#366,416 | PLANNED (low) | all | shell | — | — |

---

## 2. Coverage gaps in IA-SPEC

IA-SPEC is strong on tenancy, access and the bank-feed → close loop. It under-covers most of what makes MeritBooks a
**full book of record plus FP&A plus lender-grade controls**. In the nav (§3.6), most modules still appear as links.
The gaps are in **role homes (§4), the widget registry (§5.4), the role catalog (§2) and the consolidated context (§3.1)**:
a role can't see that a module needs it. Each fix below names a nav item, a widget id with its roles, and where it goes on the home.

### 2.1 Gap table
| # | Capability IDs | What IA-SPEC omits / under-serves | Fix — nav · widget (roles) · home placement |
|---|---|---|---|
| G1 | REV-01..07, REV-12..14 (rev rec, WIP, retainage) | **No rev-rec or WIP widget on any home.** Rev rec appears only as one cell in `ctl.close_through` and as a line in §6 step 12. There's no Revenue policy setting, and Retainage has no nav entry. | Widget **`+rr.recognition`** "Revenue to recognize this period" (proposed entries per job/contract with method, earned vs billed, **Review & approve**; done: "September recognized · posted Oct 3") → CTL home row 1 (right of close-through), BK client-home step 4 for clients with job/contract revenue, AM review queue item. Widget **`+jobs.wip`** "Over/under billing & profit fade" (CTL, CFO, FD, DH) → CFO row 3, CTL row 2. Widget **`+jobs.retainage`** (CTL, CFO: retainage due for release). Nav: C·Jobs & costing + **Retainage**; C·Client settings + **Revenue policy** (basis + method per stream, true-up rule). |
| G2 | EXP-05..07, EXP-01/03, BNK-07, PRT-04 (receipt chase) | **Receipt chase is missing entirely.** There's no cardholder/employee role, no widget, no chase settings home, and no channel or scheduler dependency. The bookkeeper's `bk.requests_out` covers client contacts only, not cardholders. | (a) New role **`employee`** (cardholder / expense submitter; own records only; mobile-first) with home **`+em.my_receipts`** (card charges missing a receipt, with camera attach, one per card) + **`+em.my_expenses`** (draft/submitted/reimbursed). (b) Widget **`+exp.missing_receipts`** (BK, AM): missing receipts by client → cardholder, reminders sent, escalated, $ unsupported at period end → BK workspace home row 2 + client-home step 1 tab. (c) **Architectural pull:** run receipt chase on the **same request/reminder engine as M-7** (`client_requests.kind += 'receipt'`, assignee = employee membership, `reminder_policy` = chase interval / escalate-after / quiet hours / channels). One reminder engine then serves client questions, receipt chase, vendor W-9/COI chase and PBC. (d) Nav: C·Payables·Receipts tab **Missing**; C·Client settings **Cards & receipt chase** (card → cardholder map, thresholds). (e) Depends on INT-01 scheduler + INT-13 SMS/push. |
| G3 | FPA-01..10, FPA-12, FPA-14..15 (FP&A) | The CFO home's only forward-looking module is a 13-week cash forecast. There's **no budget cycle, reforecast, scenarios, or variance drivers**. Department heads see BvA but never get asked to submit a budget. Profitability moved to the workspace only, so there's no in-client profitability by department/job/customer. The consolidated context excludes FP&A. | Widgets **`+fpa.flux`** "What moved and why" (top 5 variance drivers, deterministic, AI only words them; CFO, CTL, OW, FD) → CFO row 2 beside `cfo.compare`; **`+fpa.reforecast`** (CFO, FD: last reforecast date, latest forecast vs budget, **Reforecast now**); **`+fpa.scenarios`** (CFO, OW: pinned scenarios with cash/EBITDA impact); **`+fpa.budget_cycle`** (DH, FD, CFO: who has submitted, what's overdue, **Submit / Review**) → DH home row 1 during budget season. Nav: rename C·Reports → **Reports & planning** (Reports · Budgets [Plan/Drivers/Reforecast/Cycle] · FP&A & scenarios · Profitability · Board & lender packs · Basis adjustments). X context gets Budgets vs actual + FP&A (read-only). |
| G4 | DEBT-01..13 (debt, covenants, borrowing base, lenders) | Covenant headroom is on the OW/CFO homes. **Missing: borrowing-base availability, lender reporting calendar, certificate due dates, maturities, group-level covenants, and lender access.** Borrowing base is a separate nav item, not under debt. | Nav: merge into C·Banking & cash → **Debt & covenants** (tabs Register · Covenants · Borrowing base · Lender reporting). Widgets **`+debt.lender_calendar`** (CFO, CTL: per lender, what's due when — compliance cert, BBC, financials — with **Prepare**) → CFO row 2, CTL row 3; **`+debt.borrowing_base`** (CFO, OW: availability vs drawn, eligible AR/inventory trend, certificate last sent); **`+debt.maturities`** (CFO, OW: 12-month maturity/refinance ladder). Consolidated context: covenant measurement where the borrower is a group (DEBT-12). New external role **`lender_viewer`** (read-only, time-boxed, sees only packs/certs sent to them; same token pattern as the portals). |
| G5 | PAY-01, PAY-04..09 (check processor) | The payments clerk home is a single queue. **No print step, positive pay, check history/stale checks, remittance failures or ACH export.** The role key `payments_clerk` loses the owner's word "check processor". | Display label **"Check processor"** (key `payments_clerk`). Home: `pc.queue` + **`+pc.print`** (batches approved → printed/exported, check-number range, reprint/void with reason) + **`+pc.positive_pay`** (issue file sent? bank exceptions to approve/reject) + **`+pc.history`** (outstanding >90 days, voided, cleared this week) + remittance-advice send failures. Nav for this role = C·Payables·**Pay runs** only (tabs Queue · Print · Positive pay · History). CFO `cfo.release` covers ACH/wire batches too. |
| G6 | AP-01..03, AP-11, AP-13, AP-15..16, PAY-02 (bookkeeper AP) | **The bookkeeper's home has no payables modules.** The books-review loop's Review step only includes "draft bills from intake". Nothing tells anyone that bills are due, that a 3-way match failed, or that a vendor hold is blocking payment. | Widgets **`+ap.intake`** (BK, DE: draft bills from inbox/drops awaiting review, per client), **`+ap.due`** (BK, CFO: due in 14 days with no pay run, discounts expiring), **`+ap.pay_run_proposal`** (BK, AM: agent-drafted run by due date → **Review run**), **`+ap.match_exceptions`** (BK, DH: PO/receipt/bill variances), **`+ap.holds`** (BK, AM: compliance/lien-waiver holds blocking payment). Client-home step 1 gets tabs **Bank & card · Receipts · Bills · To bill**. |
| G7 | AR-01, AR-04, AR-06..07, AR-11..13 (bookkeeper AR) | AR shows up only as "AR overdue" on the owner glance and DSO on the CFO strip. **No collections worklist, unapplied cash or "ready to bill" on any processing home.** | Widgets **`+ar.collections`** (BK, AM; OW view-only: top overdue, promises due today, dunning drafts awaiting approval) → BK row 2; **`+ar.unapplied`** (BK: unapplied payments/deposits); **`+ar.to_bill`** (BK: recurring invoices due, accepted estimates not invoiced, milestones reached, unbilled 1180, management-fee billing for firm-own books). |
| G8 | VND-02..07, TAX-05..06 (vendor compliance, 1099) | Absent from every home. | **`+vc.expiring`** (BK, AM: W-9/COI missing or expiring in 60 days, chase status, holds) → BK row 3; **`+vc.portal_uploads`** (BK: vendor uploads waiting for review); **`+tax.1099`** (BK, CTL; shown Nov–Feb: readiness, W-9 gaps, file status). |
| G9 | TAX-01..10 (tax) | Only the `bk.agenda` data feed mentions sales tax and 1099 dates. **No filing grid, nexus, or provision status.** 1099 sits under Vendor compliance today. | **`+tax.filings_due`** (CTL, BK, CFO: client × obligation grid filed/due/overdue + penalty exposure) → CTL row 3; **`+tax.nexus`** (CTL). Nav: C·Accounting·**Tax** hub tabs: Sales tax · 1099 · Book-to-tax · Provision · Return package · Filing calendar. |
| G10 | FA-01..10, GL-09 (schedules) | Assets, leases, prepaids, insurance and intangibles appear only as close-through cells. | **`+ctl.schedules`** "Period schedules" (CTL; BK in step 4): depreciation, amortization, lease, prepaid, insurance, intangibles, recurring JE runs — proposed / posted / failed — **Post all proposed**. Keep the C·Accounting·**Assets & schedules** hub (existing `/assets`). |
| G11 | CASH-01..11 (cash & treasury) | No min-cash, obligations or subscriptions module. **The workspace has no cross-client cash view** (Build Spec §11 daily cash report). | **`+cash.min_cash`** (CFO, OW, CTL: clients below/projected below minimum within 14 days, suggested transfer) → CFO row 1 (next to KPI strip), OW row 2; **`+cash.obligations`** (CFO, OW: next 30 days of renewals/loan/lease/insurance payments); **`+cash.subscriptions`** (CTL, OW: creep, renewals needing keep/cancel). Nav: W·Insights + **Cash across clients**. |
| G12 | INV-01..03 | No inventory widget. | **`+inv.reorder`** (DH, BK on inventory clients); inventory tie-out shown in step 3 (already in `ctl.close_through` data — make it explicit). |
| G13 | CON-05..06 (internal invoices, client-level intercompany) | `dh.approvals` lists bills/expenses/POs but **not internal invoices**, which canon (MD II.4) routes to the receiving department head. The client nav dropped Consolidation, and with it the client's own due-to/due-from view. | Add `internal_invoices` and change orders to `dh.approvals` data. Widget **`+ic.internal_invoices`** (BK, CTL: sent-not-approved aging + per-period integrity badge). Nav: C·Accounting + **Intercompany** (due-to/due-from by counterparty, internal invoices). |
| G14 | CTRL-03..13, GL-17 (controls inside a client) | The client nav has **no Audit trail, Compliance & controls, Approvals, or PBC.** The AI decision log sits under Reports. The controller home has no SOX or AI-oversight module. | New C nav group **Controls**: Exceptions · Approvals · Compliance & SOX · Audit trail · AI decision log · Requests & PBC. Widgets **`+ctl.sox`** (CTL: control tests due/failed, evidence missing) and **`+ctl.ai_review`** (CTL, AM: sample of AI/agent decisions, override rate by feature, autonomy dial state with **Adjust**) → CTL row 3. |
| G15 | CTRL-11, AI-11 (watch rules & alerts) | Not in IA. | **`+alerts.watch`** (OW, CFO, CTL, AM: my watch rules + what fired, one-click action) → OW/CFO row 2; nav W·Settings + **Alerts & watch rules** (per user; email/Slack/Teams delivery). |
| G16 | AI-07, CLS-06, AR-13 (agents waiting on a person) | `bk.done_for_you` shows finished work, but **not agent steps paused at HUMAN_GATE.** Agents sit under Reports. | **`+ai.agent_gates`** (BK, AM, CTL: agent runs waiting for me, oldest first) → BK row 1 right column under `bk.agenda`. Move nav **Agents** to W·Work and C·Home. |
| G17 | RPT-08, RPT-13, FPA-14, DEBT-09, CON-10 (packs & delivery) | No module shows what was sent to owners, boards and lenders, or what's due. | **`+rpt.packs`** (CFO, CTL, AM: scheduled packs — next send, last sent, failed; client packets sent this period) → CFO row 3, AM row 3. Consolidated context gets Board package + lender packs. |
| G18 | ONB-04, ONB-06..07, AR-02, AR-10, EXP-06, REV-02, TAX-01, AP-03 (client setup) | The client-settings nav has profile / contacts / bank connections / checklist / assignments only. **Missing: data import & conversion, online payments (Stripe), invoice branding, inbound AP inbox, cards & receipt chase, revenue policy, sales-tax settings.** Today these live in one tenant-wide `/settings` page. | C·Client settings + **Data import & conversion · Online payments · Invoice branding · Inboxes · Cards & receipt chase · Revenue policy · Sales tax · Accounting setup** (account roles, required dimensions). Tenant-wide items (AI, routing, learned preferences, danger zone) stay in W·Settings. |
| G19 | ADM-12..13, ADM-17, ONB-10..12, CTRL-16, AI-14 (platform) | The platform nav lacks entitlements/module selection, white-label branding, sandbox, tenant export/reset and AI evals. The tenant admin can't see AI usage. | P·Tenants → tenant detail tabs **Plan & entitlements · Modules · Branding · Data (export/reset) · Sandbox**; P·Health + **AI evals**. Widget **`+ta.ai_usage`** (TA: AI spend vs budget by client/feature) on TA home. |
| G20 | §2 role catalog | **Roles missing:** employee/cardholder (G2), lender viewer (G4), external tax preparer (handled as `view_only` + Tax scope, time-boxed). AP/AR clerk is handled as an assignment function (`ap`/`ar`), so the IA should say so. "Operations leader" = department head. | Add the `employee` and `lender_viewer` system roles. State that AP clerk / AR clerk = bookkeeper or data entry + `client_assignments.function`. |
| G21 | §4 homes (thin roles) | The **FD** home is "CFO minus covenants". The **HR** home has no cross-client payroll calendar. The **owner** has no cash obligations or min-cash. The **controller** has no tax, schedules, rev rec or SOX. The **bookkeeper** has no AP, AR, vendor compliance or receipt chase. | Default templates in §2.2 below. |
| G22 | §5.4 registry categories + `requiredPermission` | Categories are Work · Close · Cash · Performance · Controls · Team · Platform. **`FEATURE_CATALOG` (`lib/rbac/permissions.ts`) has no feature keys for rev rec, budgets/FP&A, debt/covenants, borrowing base, tax, consolidation, expenses, POs, inventory, assets/leases, obligations/subscriptions, documents, exceptions, agents or internal invoices**, so many widgets have no permission to gate on. | Add categories **Payables · Receivables · Revenue & jobs · Debt & lenders · Tax & compliance · Planning · Payroll**. Extend `FEATURE_CATALOG` (reserved shared spine — the lead makes this change) **before** the registry: `rev_rec`, `jobs_wip`, `budgets`, `fpna`, `debt`, `covenants`, `borrowing_base`, `tax`, `consolidation`, `expenses`, `purchase_orders`, `inventory`, `assets`, `obligations`, `documents`, `exceptions`, `agents`, `internal_invoices`, `vendor_compliance`, `client_requests`, `alerts`. |
| G23 | §3.1 consolidated context | Offers reports, consolidation, eliminations and close status only. | Add (read-only): cash across group, BvA/FP&A, covenants measured on the group, intercompany pairs, board & lender packs, group close gate (CLS-09). |
| G24 | INT-01 scheduler | IA §6 assumes detectors run at period end, reminders go out "per policy", packs are scheduled and rev rec runs on the 1st. **No scheduler exists** (CG#2). | Add INT-01 to IA §7 as a prerequisite next to R1–R5. Each widget's "done state" must show the last-run time so a stopped job is visible. |
| G25 | `bk.agenda` data | Sources omit receipt-chase escalations, vendor doc expirations, covenant/BBC due dates, rev-rec and depreciation runs, recurring invoices. | Extend the `bk.agenda` data sources (and add a CFO/CTL version, **`+ctl.agenda`**, for lender, tax and close-gate dates). |
| G26 | AR-20, DEBT-10, ADM-23 (the firm's own business) | The owner directive makes Merit a firm tenant whose own books are a client. **No surface for billing clients (management fees/services), intercompany loans, or per-client economics.** (The retired chargeback/overhead engine must NOT come back.) | In the **Own books** context: Receivables → recurring management-fee/service invoices to related clients (internal/intercompany invoices, eliminated in consolidation); Accounting → Intercompany loans (DEBT-10). Widget **`+am.client_economics`** (AM, OW of a firm: effort per client from activity × time standards vs fee) in W·Insights. |
| G27 | mobile | IA §8 shows 390px only for the client contact. | Also design 390px versions of `+em.my_receipts` (camera-first), `ow.decisions` (approve on phone), `cfo.release`. |

### 2.2 Recommended default home templates (system layer, IA §5.1) — new modules merged with IA §4
| Role | Row 1 (primary, above the fold) | Row 2 | Row 3 / lazy |
|---|---|---|---|
| **BK** (workspace) | `bk.my_clients` (8 col) · `bk.agenda` + `+ai.agent_gates` (4 col) | `bk.ai_judgment` · `+exp.missing_receipts` · `+ap.intake` · `+ar.collections` | `bk.requests_out` · `bk.unreconciled` · `+vc.expiring` · `+ap.due` · `bk.done_for_you` · `bk.feeds` (hidden when healthy) · `+tax.1099` (seasonal) |
| **BK** (client home) | 4-step loop; step 1 tabs Bank & card · Receipts · Bills · To bill | step 4 includes `+rr.recognition`, `+ctl.schedules` (proposals) | — |
| **AM** | `am.close_grid` + review-queue chip | `am.review_queue` · `am.capacity` · `+ai.agent_gates` | `am.blocked` · `am.requests_stale` · `+exp.missing_receipts` (team) · `am.exceptions` · `+rpt.packs` · `am.quality` · `am.onboarding` · `+am.client_economics` (firm) |
| **CTL** | `ctl.close_through` (8) · `+rr.recognition` (4) | `ctl.exceptions` · `ctl.manual_jes` · `ctl.rec_signoff` · `+ctl.schedules` · `+jobs.wip` | `ctl.intercompany` · `ctl.periods` · `+tax.filings_due` · `+debt.lender_calendar` · `+ctl.sox` · `+ctl.ai_review` · `+ctl.working_papers` (when built) |
| **CFO** | `cfo.kpis` strip · `cfo.release` · `+cash.min_cash` | `cfo.compare` + `+fpa.flux` · `cfo.covenants` · `+debt.lender_calendar` · `+debt.borrowing_base` | `cfo.forecast` · `+fpa.reforecast` · `+fpa.scenarios` · `+jobs.wip` · `cfo.close_blockers` · `cfo.consolidated` · `+rpt.packs` · `+cash.obligations` · `+alerts.watch` |
| **FD** | `fd.bva` · `+fpa.flux` | `cfo.release` (scope) · `+fpa.reforecast` · `+fpa.budget_cycle` | `cfo.compare` (scope) · `+jobs.wip` · `cfo.close_blockers` (scope) |
| **OW** | `ow.decisions` · `ow.glance` | `+cash.min_cash` · `ow.covenants` · `+debt.borrowing_base` · `+alerts.watch` | `ow.books_status` · `ow.clients_compare` · `ow.consolidated` (grant) · `+cash.obligations` · `+fpa.scenarios` |
| **HR** | `hr.upcoming` (all clients in scope, calendar) | `hr.tied` · `hr.remit` | `hr.requests` |
| **DH** | `dh.approvals` (+ internal invoices, change orders) · `dh.bva` | `+fpa.budget_cycle` (in season) · `dh.pos` · `+ap.match_exceptions` | `dh.jobs` · `+inv.reorder` |
| **PC — Check processor** | `pc.queue` · `+pc.print` | `+pc.positive_pay` · `+pc.history` | — |
| **DE** | `de.drafts` · `+ap.intake` | — | — |
| **EM** (new) | `+em.my_receipts` | `+em.my_expenses` | — |
| **AU** | `au.pbc` | `au.periods` · `au.statements` | `au.audit_trail` |
| **TA** | `ta.access` · `ta.support` | `ta.access_review` · `ta.clients` | `ta.connections` · `ta.billing` · `+ta.ai_usage` |
| **PA** | `pf.funnel` · `pf.tenant_health` | `pf.billing` · `pf.integrations` · `pf.ai` | `pf.support` · `pf.errors` |

---

## 3. Carry-forward plan (code; the live UI is audited separately)

### 3.1 Move intact (engines and libs — no changes to accounting behavior)
`lib/posting/*` (engine, roles, templates, lifecycle, schedule/depreciation/recurring engines) · `lib/rev-rec` · `lib/controls/*`
(all detectors + autonomy adoption) · `lib/covenants` · `lib/borrowing-base` · `lib/cash` (trend, obligations) · `lib/forecast` · `lib/fpna` ·
`lib/budget(s)` · `lib/reports/*` (ledger, variance, basis, board-package, compiler, export, ar-aging-merge) · `lib/close/*`
(orchestration, readiness, open-items) · `lib/ap/*` (batch, export, remittance, inbound intake, doc-intelligence) · `lib/money/*`
(approvals SoD, fees, origination, providers, plaid-feed, secrets) · `lib/payroll/*` · `lib/leases` · `lib/fixed-assets` · `lib/prepaid` ·
`lib/insurance` · `lib/intangibles` · `lib/debt` · `lib/tax` · `lib/inventory` · `lib/jobs`, `lib/jobcost` · `lib/procurement` ·
`lib/consolidation` · `lib/agents/*` (runner + 6 recipes) · `lib/autonomy` · `lib/approvals` · `lib/policy` · `lib/learning` · `lib/nl` ·
`lib/search` · `lib/explain` · `lib/documents`, `lib/uploads` · `lib/portal`, `lib/audit-access` · `lib/obligations`, `lib/subscriptions` ·
`lib/customer-deposits`, `lib/estimates`, `lib/collections`, `lib/ar`, `lib/invoices` · `lib/expenses`, `lib/vendors`, `lib/customers` ·
`lib/email` · `lib/observability` · `lib/trust`, `lib/security` · `lib/import`, `lib/onboarding`, `lib/integrations` ·
`lib/team-performance` · `lib/inbox` · `lib/stitch-core.ts` · `lib/api-client.ts` · `lib/pagination.ts`. The public routes
`/pay/[token]`, `/portal/customer`, `/portal/vendor` move intact.
`lib/api-handler.ts` stays, but the lead must extend its ctx with `accessibleClientIds` / `requireClientAccess` (IA R2).

### 3.2 Re-skin only (same page and data; moves into the new shell and nav position)
Client books: `bank-feed` (+tabs credit-cards, apply-deposits), `reconciliation`, `bills` (+`intake-queue`, `policy`), `expenses`
(+`policy`), `receipts`, `purchase-orders`, `checks`, `payroll`, `vendors`, `vendor-compliance`, `compliance-1099`, `invoices`,
`estimates`, `collections`, `customers`, `customer-deposits`, `rev-rec`, `cash`, `debt`, `borrowing-base` (becomes a Debt tab),
`obligations`, `subscriptions`, `journal-entries`, `chart-of-accounts`, `assets` hub + `fixed-assets`/`leases`/`prepaids`/`insurance`/
`intangibles`/`tax-depreciation`, `internal-invoices`, `departments`, `tax` hub + `book-to-tax`/`tax-provision`/`tax-package`/`tax/sales-tax`,
`documents`, `periods`, `jobs` (+`[id]`, `wip`), **`retainage` (add to nav — orphaned today)**, `inventory` (+`[id]`, `valuation`),
`reports` (+`basis-adjustments`), `fpna`, `budgets`, `board-package`, `search`, `ai-decisions`, `agents`, `pbc`, `audit`, `compliance`.
Settings: `settings/approvals`, `settings/autonomy`, `settings/roles`, `settings/payments`, `settings/billing`, `import`,
`onboarding/conversion`, `integrations/erp`.

### 3.3 Rework (behavior or structure changes)
| Item | Today | Change |
|---|---|---|
| `lib/rbac/permissions.ts` | 9 roles incl. `merit_controller`, scope `portcos_and_3rdparty`, `biz_*` features; `FEATURE_CATALOG` missing ~20 modules | Role rename map (IA §2.5) + `employee`/`lender_viewer`; `client_scope`; extend catalog (G22). Shared spine → lead. |
| `lib/company-scope.ts`, `location-filter.ts`, `company-scope-guard.tsx`, `ui/active-company-indicator.tsx` | cookie `mb_active_company` with `'all'` sentinel | Context model (platform/workspace/client/own books/consolidated); server-validated; guard becomes "requires client context". Keep the guard concept — it's right. |
| `lib/planes.ts`, `layout/plane-switcher.tsx` | books/practice/platform planes | Retire; replaced by context switcher (⌘J). |
| `lib/navigation.ts` | 9 workflow groups, one tree | Three trees by context (IA §3.4–3.6 + G-fixes: Controls group, Reports & planning, Debt & covenants hub, Retainage, Intercompany, client-settings items). Shared spine → lead. |
| `layout/header.tsx`, `layout/sidebar.tsx` | company picker + plane switcher | Context chip + amber/steel/red bands; context-aware nav; keep notifications bell + search palette. |
| `/dashboard` (`company-board.tsx`, `activity-feed.tsx`, `enter-company.tsx`, `actions.ts`) | one fixed board for all roles | Role homes on the widget registry. Reuse `company-board` queries for `ow.clients_compare`/`am.close_grid`; the activity feed feeds `bk.done_for_you`. |
| `/portfolio`, `/portfolio/[locationId]`, `lib/portfolio/*`, `lib/companies/portfolio/*`, `/onboarding/portfolio`, `/api/portfolio*` | "Entities"; no permission checks | `/clients` registry + profile, `lib/clients/*`, `/onboarding/clients`, `/api/clients*` with permissions + scope filter (IA §3.7, R2). |
| `/operations` (419 lines) | client health | Folds into W·Insights·Books health. |
| `/team` (`team-client.tsx`, `performance-panel.tsx`, `create-company-dialog.tsx`) | team + access + performance + add company | Split into W·Team (Staff & capacity, Assignments, Access) and W·Insights·Team performance; add-company → W·Clients. |
| `/close` (`close-grid.tsx`, `close-tabs.tsx`) | per-org close board | `close-grid` becomes `am.close_grid` + W·Work·Close grid; per-client tasks become step 4. |
| `/inbox` (`inbox-client`, `exceptions-queue`, `use-list-keynav`, `use-inbox-snooze`) | ranked inbox | Keep as W·Home·Inbox; `exceptions-queue` becomes client step 3; keynav/snooze hooks reused by every queue. |
| `/consolidation` (1,275 lines) | statements + intercompany tab, client-side `canConsolidate` | Split: group setup (W·Consolidations) + statements in X context via `requireGroupAccess` (R4); intercompany tab → C·Accounting·Intercompany. |
| `/platform` (`operator-dashboard`, `ops-health-dashboard`, `fee-revenue-report`) | read-only console | Extend into the P nav (provisioning, lifecycle, support access, defaults); reuse the three components as `pf.*` widgets. |
| `/settings` (273 lines, 10 tabs) | tenant-wide everything | Split W·Settings (org, AI, routing, learned, danger) vs C·Client settings (chase, rev-rec policy, sales tax, branding, inboxes, cards). |
| `lib/help/help-content.ts` | "portfolio" copy | Rewrite to "clients" / "consolidation group". |
| `lib/identity/*` | memberships auto-provision; authority via `employees.role` | Memberships become the authority (M-3/M-5); `employees` = HR record. |

### 3.4 Retire / fold (code)
`/categorize` (fold into To review) · `/flagged` (already redirects → remove after one release) · `/recurring` legacy duplicate
(→ `/journal-entries?tab=recurring`) · `/invoices/collections` (redirect) · `/settings/permissions` (duplicate of `/settings/roles`) ·
`/sandbox` (move under P·Tenants) · `biz_*` feature keys + `business_user` (the `/business/*` pages were never built) ·
`plane-switcher.tsx` · `canSeeMeritManagement()` · the `'all'` company sentinel. **Keep the redirect stubs for one release**
(`covenants`, `forecast`, `credit-cards`, `cash-application`, `intercompany`, `exceptions`, `controls`, `close-status`,
`year-end-close`, `sales-tax-calendar`, `sales-tax-return`, `budgets/drivers`, `budgets/reforecast`, `recurring-journal-entries`) — they protect deep links.

### 3.5 UX patterns in code worth keeping (apply them to the new homes and queues)
- **`DetailDrawer` + hover-peek** (`hover-peek.tsx`) + `.row-clickable`: every row opens its record; peeks are real document previews.
- **Hub + `?tab=` deep links** (`_components/hub-tabs.tsx`, `section-tabs.tsx`) plus redirect stubs: short nav, deep pages.
- **Drop-and-parse review** (`*-parse-review.tsx` for debt, covenants, leases, prepaids, insurance, subscriptions): AI fields + confidence + accept/edit. Use the same pattern for Ramp items and client answers.
- **Bank-feed queue mechanics**: j/k/a/f/Space/Esc, band select, vendor batch, saved views, `confidence-bar.tsx`, `confidence-explainer.tsx`. Make this the standard for every review queue (`bk.ai_judgment`, `+ap.intake`, `+exp.missing_receipts`).
- **Inbox `use-list-keynav` + `use-inbox-snooze`**: keyboard triage and snooze for every list widget.
- **`ApprovalChainStatus`** visualizer and **`PaymentFraudCard`** inline at release (`cfo.release`, `ow.decisions`).
- **`ExplainPanel`** / `/api/explain` and **`narrative-panel`** with the "Computed (AI unavailable)" label: honest about the AI.
- **`ai-unavailable-notice.tsx`**: IA rule 8 already exists in code.
- **Edit-with-override** (typed reason → audit → reverse + re-post); **AttachmentsPanel** on every money object.
- **NL command bar panels** (`components/nl/*`: analytical/processing/result) and the **search palette**; ⌘K stays.
- UI primitives `EmptyState`, `Skeleton`, `Toast`, `MetricCard`, `StatusBadge`, `DataTable`, `PageHeader` back IA rule 4 (empty vs done states).

---

## 4. Retired — never rebuild
| Item | Canon |
|---|---|
| Chargeback engine (chargebacks page, `chargebacks/generate` API, `chargeback.ts`, 6-section chargeback invoice, GL-by-employee-dept rules, chargeback generation cron, two-phase chargebacks) | MD Part VI, Cat 10 #221–238, #423, #429; BS §12, §25 #4 |
| Overhead / burden-rate engine (`overhead-rate.ts`, API, `overhead_rate_periods`, monthly OH recalc cron, burdened-cost formula) | MD Part VI, #421; BS §12, §19 |
| 5 labor classifications (`employees.labor_type`), production utilization flagging, billing-efficiency rankings (#342–343) | MD Part VI; CA §2 |
| Cost-allocation / shared-cost rules (`shared_cost_rules`, `shared_cost_allocations`) | MD Part VI |
| In-app time tracking, time review, mobile time clock + GPS, office-worker timer, supervisor time gate, AI dept-setup wizard (time-clock config), config lock, PM-tool time integrations, mobile dept setup, 3 mobile roles | MD Part VI, #347–350, #383–391, #399, #405, #427 — time lives in the PM module |
| Overhead-config onboarding step (#374) | MD Cat 19 (replaced by Departments + charge method) |
| MeritContext / "CPA Desk → MeritContext" | MD I.3, #434 |
| Coded platform-fee GL path (`PLATFORM_ORG_ID`, fee posting onto Merit's books) | CA §5 (GATE 12.1) |
| QBO / Sage / Xero as a live system of record or sync-back | MD I.1, IX — migration import sources only |
| Hardcoded Merit concepts: "portfolio", "portco", "holding company", fixed entity list, `merit_controller`, `portcos_and_3rdparty`, `canSeeMeritManagement()` | MD I.2, OD, IA §3.7 |
| `business_user` + `/business/*` pages; Practice plane; `'all'` company sentinel | IA §2.5, §3 |
| Hardcoded fee constants `CARD_PCT`/`ACH_PCT` (replaced by the fee model) | FPB-payments-fees |
| "251 seed accounts" claim (the template is 137, accepted) | CA §2 |

**Do not confuse:** management-fee billing (AR-20) and intercompany loans (DEBT-10) are **live requirements**. Build them on
internal/intercompany invoices and the debt register, never on the retired overhead/chargeback model.

---

## 5. Counts
- **Capabilities catalogued: 346** across 26 domains. Cross-references are not counted twice. Mixed statuses such as
  "LIVE/PARTIAL" or "LIVE engine · STUB provider" are counted by their first token.
- By code status: **LIVE 160 · PARTIAL 82 · STUB 5 · PLANNED 99** (RETIRED items are listed in §4, not counted).
- Per domain: GL 20 · DIM 7 · CLS 14 · BNK 15 · REC 9 · AP 17 · PAY 15 · EXP 12 · AR 20 · REV 19 · INV 4 · FA 11 · DEBT 13 ·
  CASH 11 · PRL 11 · TAX 12 · FPA 19 · RPT 14 · CON 10 · CTRL 16 · VND 8 · PRT 4 · ONB 12 · INT 14 · AI 15 · ADM 24.
- **IA-SPEC coverage gaps: 27** (G1–G27), proposing **43 new widgets** (`+` ids) and **2 new roles** (`employee`, `lender_viewer`).
