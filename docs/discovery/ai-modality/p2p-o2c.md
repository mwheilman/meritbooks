# AI Modality × Segment Grid — Procure-to-Pay & Order-to-Cash (Books, Module 1 of 12)

**Authors:** discovery-panel AI engineer with the P2P and O2C cluster SMEs.
**Date:** 2026-08-01 (Session 42 canon).
**Status:** Discovery / analysis + spec. **Nothing here is a build authorization.** Every capability must
earn an approved Rule-13 FPB and land behind its `Prereq:` gate before a line of code is written.

**Why this doc exists.** The v2 capability catalog (`docs/discovery/AI-CAPABILITY-CATALOG-v2.md`) enumerated
~205 capabilities *segment-first*. A segment-first pass misses capabilities that only appear when you force
**every AI modality against every segment** — exactly how a pervasive natural-language FP&A surface was
missed on the first pass. This pass builds the **segment × modality grid by construction**: for each of the
nine P2P/O2C segments we walk all 14 modality columns and fill every cell, then flag every cell that has **no
home in catalog v2** as **⭐NEW**. The intent is exhaustiveness-by-construction, not novelty for its own sake.

**Canon posture inherited by every cell (never restated per-row):** AI **proposes a fact or a draft → the
deterministic engine does any accounting (debits=credits, direction from account TYPE, role-not-number) → a
human with the right `core` role approves anything that moves money, changes the book, changes vendor/customer
banking, or touches a relationship → every AI action + human decision writes `core.action_log` / `ai_decisions`.**
**AI never moves money and never initiates a transfer** (CANON-ANCHOR §3). Auto-post is OFF by default;
autonomy is a per-tenant/per-task dial. Money is bigint cents. AI routes only through `@meritbooks/core-ai`
(metered, tenant-budget capped). Customer/Vendor/Item/Entity are `core`, referenced by FK; the ledger is `public`.

---

## Legend

**Modalities (columns):**
| M | Modality |
|---|---|
| M1 | Doc extraction / OCR / IDP |
| M2 | Classification & coding |
| M3 | Entity matching & reconciliation (dedupe, invoice↔PO↔receipt, cash-application) |
| M4 | Anomaly / fraud / control detection |
| M5 | Forecasting & prediction |
| M6 | Content generation & drafting |
| M7 | Narrative & explanation |
| M8 | Conversational NL interface |
| M9 | Agentic multi-step orchestration |
| M10 | Autonomy governance & human-in-loop |
| M11 | Recommendation & optimization |
| M12 | Monitoring & proactive alerting |
| M13 | Search & retrieval / knowledge |
| M14 | Learning & personalization (per-tenant / per-entity memory) |

**HITL posture:** `propose→approve` (default) · `detect→triage` (advisory to `/exceptions`) · `hard-gate`
(blocking control) · `human-release` (money movement, preparer≠approver + explicit release) · `elevated-role`
(SoD-gated) · `read-only` (derived intelligence) · `auto-clear(dial)` (only within the autonomy dial, always
reversible + logged).

**Build-state (verified against the live repo, Session 42):** **built** (working, incl. shipped detect-only) ·
**partial** (substrate exists, material gap) · **spec** (named in catalog v2 / an FPB, no code) · **NONE**
(no code and no catalog home — almost every ⭐NEW cell). **⭐NEW** = not represented in catalog v2.

**Repo evidence base:** `lib/controls/*` (11 detectors verified: anomalous-je, bill-anomaly, cash-application,
cutoff-errors, duplicate-payments, intercompany-balance, missed-accruals, revenue-not-recognized,
sales-tax-nexus, uncategorized-leakage), `lib/ap/intake.ts`, `lib/services/{categorization,vendor-compliance,
je-composer,exception-ai,reconciliation-*}.ts`, `lib/invoices/*`, `lib/cash/forecast.ts`, `lib/money/*`,
`lib/trust/score-tier.ts`, `lib/identity/*`, `api/{bills,bank-feed,payments,invoices,credit-memos,receipts,
credit-cards,checks,reconciliation,forecast,vendor-compliance,customers,vendors,controls}`. **Confirmed
structural gaps:** no PO model in Books (`purchase_order` appears only in `bill-anomaly.ts` comments +
legacy migration 029; `public.bills` carries no `purchase_order_id`); no employee-expense-report or
card-issuance model; `scoreToTier` (`lib/trust/score-tier.ts`) computes tiers but is **not wired to any
auto-post/queue disposition** (logging-only).

---

## THE GRID

Each cell: **capability — one line.** `HITL` · **build** · ⭐NEW where applicable. `—` = not meaningful for
that segment (+ one-word why).

### Segment 1 — AP / Bills

| M | Capability | HITL | Build |
|---|---|---|---|
| M1 | Line-level invoice PDF/image extraction (header + lines + tax/freight) → draft bill | propose→approve | **partial** (`ap/intake.ts`+`bill-parser.ts`; no source-doc vault, no line-GL) |
| M2 | Vendor-history line coding (GL + dept/location/class) + tax-character (M-1) tag | propose→approve | **partial** (feed learning built; bill lines fall back to vendor default/6660) |
| M3 | Duplicate-bill / bill↔feed-payment matching; disbursement↔bank clearing | detect→triage / hard-gate | **partial** (EC-1 post-hoc built; no inline intake block; no bill↔feed guard) |
| M4 | Bill-amount anomaly + duplicate-payment detection (round-dollar / first-time-large) | detect→triage | **built** (`bill-anomaly.ts`, `duplicate-payments.ts`) |
| M5 | Payment-timing / dynamic-discount optimizer (2/10≈36%) + AP cash-requirement feed | propose→approve | **spec** (AP-F2/I6; needs terms model) |
| M6 | ⭐NEW **Remittance-advice generation** to the vendor on payment (what was paid, which invoices) | propose→approve | **NONE** |
| M7 | ⭐NEW Per-bill **coding/flag rationale** ("why 5040 + this job, why flagged dup") shown at review | read-only | **NONE** (decision-log infra exists; no bill-level explanation UX) |
| M8 | ⭐NEW NL AP query/command ("unpaid bills >30d for Acme; schedule the discount-eligible ones") | propose→approve | **NONE** (`je-composer` is JE-only) |
| M9 | ⭐NEW **AP agent**: inbox→extract→code→match→route-approval→schedule→pay→reconcile as one supervised loop | propose→approve / human-release | **NONE** (pieces exist; no orchestration) |
| M10 | Confidence-tier routing + per-task autonomy dial on bill coding/approval | hard-gate / auto-clear(dial) | **partial** (PW4; `scoreToTier` not wired to disposition) |
| M11 | Approval-SLA nudges to protect discounts/due dates; pay-run optimization | propose→approve | **spec** (AP-E3; `received_at` stamped only) |
| M12 | Contract/subscription-renewal + auto-renew-trap + price-drift monitoring | detect→triage | **spec** (AP-I5) |
| M13 | ⭐NEW Vendor/contract **knowledge retrieval** ("terms on file, last 3 invoices, is this in-contract") | read-only | **NONE** |
| M14 | Per-vendor coding memory (descriptor→account/dimension learning loop) | read-only | **built** (feed patterns, mig 040; bill-side partial) |

### Segment 2 — Vendor Management & Compliance

| M | Capability | HITL | Build |
|---|---|---|---|
| M1 | W-9 / COI (GL+WC) field extraction (TIN, entity type, coverage, expiry) | hard-gate | **partial** (doc tracked; no field extraction / TIN read) |
| M2 | Vendor classification: 1099-reportability, entity type, related-party, sub-vs-supplier | propose→approve | **partial** (`vendor-compliance.ts`; classification thin) |
| M3 | Duplicate-vendor-master detection & merge proposal (TIN + name/email/address similarity) | propose→approve | **built** (EC-1 rule C, `scoreDuplicateVendors`) |
| M4 | **BEC / vendor-bank-change** quarantine + dual-control; OFAC/sanctions screen | human-release / detect→triage | **spec** (AP-B4/BC-E2 top-priority; AP-B6 OFAC spec) |
| M5 | ⭐NEW **Vendor-reliability / delivery-risk score** (late delivery, dispute rate, price creep) | read-only | **NONE** (spend concentration AP-I4 is the nearest, partial) |
| M6 | COI/W-9 expiry chase letters + bank-change verification request drafting (operator voice) | propose→approve | **built** (scheduled; send blocked GATE 4) |
| M7 | ⭐NEW Vendor **compliance-status narrative** ("payable-blocked: WC COI lapsed 8d, W-9 present") | read-only | **partial** (hold computed; no narrative) |
| M8 | ⭐NEW NL vendor query ("which subs are uninsured / missing W-9 / over 10% of spend") | read-only | **NONE** |
| M9 | ⭐NEW **Vendor-onboarding agent**: collect W-9→TIN-match→COI→bank-verify→activate, chasing each gap | propose→approve | **NONE** (compliance gates exist; no orchestration) |
| M10 | Compliance-hold payment gate + override-with-reason, fully audited | hard-gate | **built** (`enforcePaymentAllowed`) |
| M11 | ⭐NEW Vendor-consolidation / preferred-vendor recommendation (dedupe spend, negotiate leverage) | propose→approve | **NONE** |
| M12 | COI/W-9 expiry + continuous OFAC/watchlist **re-screen** monitoring | detect→triage | **partial** (expiry chase built; continuous OFAC re-screen NONE) |
| M13 | ⭐NEW Vendor-360 / knowledge retrieval (docs, banking history, prior disputes, related entities) | read-only | **NONE** |
| M14 | ⭐NEW Vendor-master **enrichment memory** (learned remit-to, contacts, normalized name) | read-only | **NONE** |

### Segment 3 — Bank & Cash / Bank Feed

| M | Capability | HITL | Build |
|---|---|---|---|
| M1 | Statement import + parse (CSV/OFX/QFX) for non-Plaid accounts | propose→approve | **spec** (BC-B7) |
| M2 | AI bank-feed auto-categorization (GL+vendor+dept, confidence-sorted lowest-first) | propose→approve / auto-clear(dial) | **built** (`categorization.ts`, bank-feed page) |
| M3 | Reconciliation autopilot (Vendor40/Amount40/Date20→tier) + deposit→open-AR cash-app + transfer detect | propose→approve | **built** (autopilot, cash-app; split/transfer detect spec) |
| M4 | Duplicate-payment / bank-fee-creep / NSF-return / anomalous-cash-entry detection | detect→triage | **partial** (dup + anomalous built; bank-fee/NSF spec) |
| M5 | 13-week direct forecast + behavior-adjusted collection dates + scheduled-outflow overlay | read-only / propose→approve | **partial** (13-wk built; behavior + outflow overlay spec) |
| M6 | Reconciliation report (PDF) + adjusting-entry drafting from statement lines | propose→approve | **partial** (adjusting entries built; PDF report spec) |
| M7 | "Find the difference" AI diagnosis (transposition / missed fee / duplicate) | detect→triage | **spec** (BC-B5) |
| M8 | ⭐NEW NL cash query ("consolidated position by entity; which accounts breach minimum this week") | read-only | **NONE** |
| M9 | ⭐NEW **Morning-cash agent**: pull balances→flag stale feeds→net position→propose funding/sweep | read-only / human-release | **NONE** (dashboard built; no orchestrated routine) |
| M10 | Autonomy dial + batch-accept for the safest categorization/reconciliation tier | hard-gate / auto-clear(dial) | **partial** (`scoreToTier` computes; no auto-accept path) |
| M11 | Sweep / idle-cash optimization + intercompany cash pooling (propose, never move) | human-release | **spec** (BC-C4/C5) |
| M12 | Balance-freshness / stale-feed + payroll & debt-service cash-safety alerting | detect→triage / hard-gate | **partial** (freshness partial; safety alert spec) |
| M13 | ⭐NEW Retrieval over rec/transaction history ("show every prior match for this descriptor") | read-only | **NONE** |
| M14 | Vendor-pattern learning loop (confirmed coding → cheaper Tier-1 match) | read-only | **built** (`learnVendorPattern`) |

### Segment 4 — AR / Invoices

| M | Capability | HITL | Build |
|---|---|---|---|
| M1 | Customer-PO / signed-proposal capture + PO-number extraction onto the invoice | propose→approve | **spec** (AR-A6; `po_number` col unused) |
| M2 | Item-catalog-driven line coding + rev-rec-aware posting (credit Deferred Rev 2410) | propose→approve / read-only | **partial** (rev-rec credit built; item catalog spec) |
| M3 | Revenue-leakage reconcile (JOB_COST vs JOB_BILLING; earned>billed; 1180 roll-forward) | propose→approve | **partial** (seam + `revenue-not-recognized.ts`; unbilled-WIP detector spec) |
| M4 | ⭐NEW **Pre-send billing-error detection** (wrong price/qty/tax, missing PO → silent-dispute risk) | propose→approve | **NONE** |
| M5 | AR expected-collection feed into 13-week forecast (behavior-weighted pay dates) | read-only | **partial** (feed exists; behavior weighting spec) |
| M6 | Branded invoice delivery (email+PDF+Pay-Now) + recurring-invoice generation | propose→approve / auto-send(dial) | **built** (`invoice-email.ts`, recurring mig 073) |
| M7 | ⭐NEW Invoice/AR **narrative** ("this invoice credits Deferred 2410 because job X is % -complete rev-rec") | read-only | **NONE** |
| M8 | ⭐NEW NL invoice creation/query ("bill Acme for March retainer; show unpaid > $10k") | propose→approve | **NONE** |
| M9 | ⭐NEW **Quote→invoice→deliver→collect** order-to-cash agent (supervised) | propose→approve | **NONE** (pieces built; no orchestration) |
| M10 | RBAC + SoD on issue/void/credit-memo/write-off; recurring auto-send dial | elevated-role / auto-clear(dial) | **partial** (permissions defined; enforcement = gate #9) |
| M11 | ⭐NEW **Invoice send-time / channel optimization** (when a customer is likeliest to pay fast) | propose→approve | **NONE** |
| M12 | Unbilled-revenue / delivery-bounce monitoring (work done not billed; "never received") | detect→triage | **partial** (VIEWED tracked; bounce webhook + WIP detector spec) |
| M13 | ⭐NEW Retrieval over invoice/customer history ("every invoice + status + note for this account") | read-only | **NONE** |
| M14 | ⭐NEW Per-customer invoice memory (preferred format, PO requirement, AP contact learned) | read-only | **NONE** (recurring templates built, but not learned personalization) |

### Segment 5 — Collections & Cash Application

| M | Capability | HITL | Build |
|---|---|---|---|
| M1 | ⭐NEW **Email/PDF remittance-advice parsing** (payer + invoice list) — distinct from bank-file | propose→approve | **NONE** (lockbox/BAI2 file spec AR-C23; email remittance not modeled) |
| M2 | Deduction / short-pay reason-code classification (pricing / shortage / promo / damage) | propose→approve | **spec** (AR-C26 dispute workflow) |
| M3 | AI cash application (deposit→open AR; single / lump subset-sum / split) | propose→approve | **built** (propose-only, `cash-application.ts`) |
| M4 | Broken-promise + short-pay + at-risk (deteriorating days-to-pay) detection | detect→triage | **partial** (at-risk spec; short-pay spec; cash-app residual built) |
| M5 | Credit scoring + bad-debt / write-off candidate prediction (allowance) | propose→approve | **partial** (write-off posting built; scoring + allowance spec) |
| M6 | Tone-escalating dunning drafting (courtesy→firm→final) in tenant brand voice | propose→approve / auto-send(dial) | **spec** (AR-C14/C15; manual rung `/remind` built) |
| M7 | ⭐NEW Collections **account-summary narrative** ("promised Fri, broke 2x, 68 DTP vs 41 avg, $12k") | read-only | **NONE** |
| M8 | ⭐NEW NL collections query ("who to call today, biggest × oldest, exclude disputed") | read-only | **partial** (worklist built; no NL) |
| M9 | Automated tiered dunning ladder as a supervised agent (quiet-hours, pause, auto-stop on pay) | propose→approve / auto-send(dial) | **spec** (AR-C14; the collections moat) |
| M10 | Autonomy dial per dunning tier (advisory → trusted auto-send); write-offs never auto | hard-gate / auto-clear(dial) | **partial** (dial spec; SoD on write-off = gate #9) |
| M11 | Collections prioritization ($×age) + ⭐NEW **early-pay-discount offer** optimization | read-only / propose→approve | **partial** (worklist built; discount-offer NONE) |
| M12 | Promise-to-pay tracking + broken-promise escalation + churn/at-risk alerting | detect→triage | **spec** (AR-C16/C21) |
| M13 | ⭐NEW **Collections-interaction retrieval** ("what was already tried / said on this account") — kills double-chasing | read-only | **NONE** (AR brief flags "no memory of what was tried") |
| M14 | Per-customer payment-behavior learning (days-to-pay, promise reliability, dispute rate) | read-only | **partial** (credit columns exist; learning loop spec) |

### Segment 6 — Customer Management

*COVERAGE-MATRIX flags this segment thin; the grid surfaces the most ⭐NEW cells here — customer-side mirrors
of vendor controls that were never enumerated.*

| M | Capability | HITL | Build |
|---|---|---|---|
| M1 | ⭐NEW Customer-onboarding **doc extraction** (credit application, W-9, resale/exemption cert) | propose→approve | **NONE** |
| M2 | ⭐NEW Customer **classification / segmentation** (industry, risk band, terms tier, tax status) | propose→approve | **NONE** |
| M3 | ⭐NEW **Duplicate-customer detection & merge** (the customer-side mirror of the built vendor dedupe) | propose→approve | **NONE** (vendor dedupe built; customer side never enumerated) |
| M4 | ⭐NEW Customer credit-abuse / fraud detection (order-then-dispute pattern, split orders under limit) | detect→triage | **NONE** |
| M5 | Credit scoring + churn/at-risk prediction on the AR book | read-only | **partial** (AR-C18/C21; columns exist, no scoring) |
| M6 | ⭐NEW Customer-facing comms drafting (welcome, terms-change, statement cover, dispute reply) | propose→approve | **NONE** |
| M7 | ⭐NEW **Customer-360 narrative** ("$210k YTD, 44 DTP, 1 open dispute, limit 80% used, slowing") | read-only | **NONE** |
| M8 | ⭐NEW NL customer query ("top 10 customers by overdue; who is over limit") | read-only | **NONE** |
| M9 | ⭐NEW **Customer-onboarding + credit-review agent** (collect docs→pull references→propose limit/terms) | propose→approve | **NONE** |
| M10 | RBAC + SoD on credit-limit / terms changes; reconcile to `core` identity | elevated-role | **partial** (gate #9) |
| M11 | Credit-limit / terms optimization (right-size to behavior); credit-hold recommendation | propose→approve | **partial** (AR-C18/C19 spec) |
| M12 | ⭐NEW Credit re-review triggers + **customer-master staleness** monitoring (stale credit is a leak) | detect→triage | **NONE** |
| M13 | ⭐NEW Customer **knowledge retrieval** (contacts, PO rules, prior disputes, comms history) | read-only | **NONE** |
| M14 | ⭐NEW Per-customer **preference/behavior memory** (billing format, AP portal, remittance quirks) | read-only | **NONE** |

### Segment 7 — Money Movement / Payments

*Canon hard rail: **AI never initiates a transfer**; every money-out is preparer≠approver + explicit human release.*

| M | Capability | HITL | Build |
|---|---|---|---|
| M1 | — (payment instructions are structured data, not documents) — *n/a* | — | — |
| M2 | ⭐NEW Payment-**rail classification** (check/ACH/wire/card/on-account) + correct cash-side account | propose→approve | **partial** (rail→account logic built mig 043/055; no AI rail suggestion) |
| M3 | Disbursement ↔ bank-settlement matching / clearing (stale-check surfacing) | propose→approve | **partial** (autopilot general; AP-specific spec) |
| M4 | ⭐NEW **Payment-run fraud screen at release** (new payee, unusual amount, sanctions, positive-pay/ACH-filter) | human-release / hard-gate | **partial** (SoD built; payee/positive-pay screen spec/NONE) |
| M5 | Payment-timing prediction + ⭐NEW **settlement-date prediction** (when will this ACH/check clear) | propose→approve | **partial** (timing spec AP-F2; settlement prediction NONE) |
| M6 | ⭐NEW **Remittance-advice + payment-confirmation** generation to the payee | propose→approve | **NONE** |
| M7 | ⭐NEW Payment **cash-impact narrative** ("this run clears $84k across 12 vendors, low-water Wk3") | read-only | **NONE** |
| M8 | ⭐NEW NL pay command ("release the approved discount-eligible bills under $10k from Ops") | human-release | **NONE** |
| M9 | ⭐NEW **Pay-run agent** (build run→route approval→fund check→release→remit→reconcile), release stays human | propose→approve / human-release | **partial** (`checks/run` prepares only; no orchestration) |
| M10 | Money-movement SoD (preparer≠approver≠releaser) + explicit release + full audit | human-release | **built** (mig 042/043, `money/approvals.ts`; RBAC reconcile = gate #9) |
| M11 | ⭐NEW **Rail optimization** (cheapest/fastest rail; virtual-card rebate; discount vs float) | propose→approve | **NONE** (discount side AP-F2 spec) |
| M12 | ⭐NEW **Payment-status / failed-payment monitoring** (returned ACH, bounced check, stuck wire) | detect→triage | **NONE** (NSF handling BC-E6 spec) |
| M13 | ⭐NEW Payment-history retrieval ("every payment to this payee, by rail, with remittance") | read-only | **NONE** |
| M14 | ⭐NEW Learned **payment preference** per vendor (preferred rail, remit contact, batch timing) | read-only | **NONE** |

### Segment 8 — Expense & Card Management

*Repo has receipt capture + AI categorize and a CC-transactions-as-payable view — but **no employee
expense-report, card-issuance, policy, mileage/per-diem, or reimbursement model**. Most of the segment is
genuinely new territory, and most cells are ⭐NEW because catalog v2 treats cards only as a bank-feed source.*

| M | Capability | HITL | Build |
|---|---|---|---|
| M1 | Receipt image capture + OCR (vendor / amount / date / tax) | propose→approve | **partial** (`receipts/submit` + `receipts/categorize`; no line/tax detail) |
| M2 | Receipt / card-transaction GL + dimension coding via categorizer | propose→approve | **partial** (`categorization.ts`; no post/approve path) |
| M3 | **Receipt ↔ card-transaction ↔ bill matching** (3-way for spend, avoid double-count) | detect→triage / hard-gate | **partial** (CC view shows receipt-match status; matcher spec) |
| M4 | ⭐NEW **Expense-policy / out-of-policy detection** (limit breach, personal, missing receipt, duplicate) | detect→triage | **NONE** |
| M5 | ⭐NEW Expense **accrual / spend forecast** (unsubmitted receipts, recurring card spend) | read-only | **NONE** |
| M6 | ⭐NEW Expense-report / reimbursement-summary + policy-exception drafting | propose→approve | **NONE** |
| M7 | ⭐NEW Card-spend **narrative** ("$6.2k on the shared card: 60% job material, 2 uncoded, 1 over-limit") | read-only | **NONE** |
| M8 | ⭐NEW NL expense query ("uncoded receipts > $75 with no match this month") | read-only | **NONE** |
| M9 | ⭐NEW **Capture→code→match-receipt→approve→reimburse** expense agent | propose→approve / human-release | **NONE** |
| M10 | Autonomy dial + SoD on reimbursement release (submitter≠approver) | human-release / auto-clear(dial) | **partial** (money-movement spine reusable; expense wiring NONE) |
| M11 | ⭐NEW **Missing-receipt / uncoded-card chase** + card-program optimization (rebate, right card) | propose→approve | **NONE** (CC "chase count" column exists; no orchestration) |
| M12 | ⭐NEW Uncoded-card-line + missing-receipt aging + policy-breach alerting | detect→triage | **partial** (uncategorized-leakage detector adjacent; card-specific NONE) |
| M13 | ⭐NEW Expense-policy / prior-approval retrieval ("is this category allowed; who approved last") | read-only | **NONE** |
| M14 | ⭐NEW Per-employee / per-card coding memory (this card's charges usually code to job X) | read-only | **NONE** |

### Segment 9 — Procurement / Purchase Orders / 3-way Match

*Keystone gap: **no PO model in Books** (AP-D1, NEEDS-CENTRAL). It blocks 3-way match, encumbrance, RNI
auto-draft, and completes cost→job attribution. The procurement **front half** (requisition, sourcing,
receiving) was never enumerated as its own segment — hence the ⭐NEW density.*

| M | Capability | HITL | Build |
|---|---|---|---|
| M1 | ⭐NEW **PO / quote / goods-receipt document extraction** (receiving OCR distinct from invoice OCR) | propose→approve | **NONE** (invoice OCR partial; receipt-of-goods NONE) |
| M2 | ⭐NEW PO-line **commodity / cost-code classification** at requisition | propose→approve | **NONE** |
| M3 | **3-way (PO↔receipt↔invoice) + 2-way (PO↔invoice) match** on price/qty/terms | propose→approve / hard-gate | **spec** (AP-D2/D3; blocked on PO model) |
| M4 | ⭐NEW **Maverick/off-contract spend + split-PO threshold-dodge** detection | detect→triage | **NONE** (bill-split hinted; PO-split detector NONE) |
| M5 | ⭐NEW **Commitment / encumbrance forecast** + demand/spend forecast against job budget | read-only | **NONE** |
| M6 | ⭐NEW **PO / RFQ draft generation** from a requisition or reorder point | propose→approve | **NONE** |
| M7 | ⭐NEW **PO-variance narrative** ("invoice 12% over PO; qty 120 vs 100; unit $12 vs $10 contracted") | read-only | **NONE** |
| M8 | ⭐NEW NL procurement command ("raise a PO to Acme for 100 units at contract price against job 7") | propose→approve | **NONE** |
| M9 | ⭐NEW **Requisition→PO→receive→3-way match→bill** procure-to-pay agent | propose→approve | **NONE** |
| M10 | PO-approval routing + SoD (requisitioner≠approver≠receiver) | elevated-role | **partial** (cost-approval-rules substrate; PO wiring NONE) |
| M11 | ⭐NEW **Sourcing / vendor-selection + contract-price-compliance** optimization | propose→approve | **NONE** |
| M12 | ⭐NEW **Over-commitment / encumbrance-vs-budget** + receiving-overdue alerting | detect→triage | **NONE** (2-way variance AP-D3 spec is the nearest) |
| M13 | ⭐NEW **Catalog / contract-price retrieval** (punchout-style "what's the contracted price/lead time") | read-only | **NONE** |
| M14 | ⭐NEW Learned PO coding / preferred-vendor-per-commodity memory | read-only | **NONE** |

---

## ⭐NEW capabilities this pass surfaced (not in catalog v2)

Forcing all 14 modalities against all 9 segments surfaced **48 capability cells with no home in catalog v2.**
Grouped by the theme they expose:

**A. Whole-segment blind spots (catalog treats these only obliquely).**
1. **Customer Management as a first-class segment** — customer dedupe/merge (M3), onboarding doc extraction
   (M1), classification/segmentation (M2), credit-abuse detection (M4), customer-360 narrative (M7),
   customer knowledge retrieval (M13), preference memory (M14), re-review/staleness monitoring (M12),
   onboarding+credit-review agent (M9), customer comms drafting (M6). *The vendor side of nearly every one
   of these is built or specced; the customer mirror was never enumerated.* **10 cells.**
2. **Expense & Card Management as a segment** — policy/out-of-policy detection, expense accrual/spend
   forecast, expense-report drafting, card-spend narrative, NL expense query, capture→reimburse agent,
   missing-receipt chase + card-program optimization, policy-breach aging, policy retrieval, per-card
   coding memory. *Catalog treats cards only as a bank-feed source (BC-A2/A5); the employee-spend
   lifecycle is absent.* **10 cells.**
3. **Procurement front-half** (before AP) — goods-receipt/PO OCR, PO-line commodity coding, maverick /
   split-PO detection, commitment/encumbrance forecast, PO/RFQ drafting, PO-variance narrative, NL
   procurement command, requisition→match agent, sourcing/price-compliance optimization,
   encumbrance-vs-budget alerting, catalog/contract-price retrieval, PO coding memory. *Catalog names
   3-way match and the PO model but not the sourcing/receiving/requisition surface.* **12 cells.**

**B. Cross-cutting modality misses (recur in every P2P/O2C segment; catalog under-serves them).**
4. **M8 Conversational NL over each transactional segment** — AP query, vendor query, cash query, invoice
   create/query, collections query, customer query, pay command, expense query, procurement command.
   Catalog's PW5 covers only the **JE composer + reports NL box**; the *transactional* NL surface (the
   FP&A-style front door for AP/AR/cash/pay) is the same class of miss that this whole exercise exists to
   catch. **~9 cells.**
5. **M7 Per-object narrative/explanation** at the transaction level — bill coding/flag rationale, vendor
   compliance status, invoice rev-rec treatment, collections account summary, customer-360, payment
   cash-impact, card-spend, PO-variance. Catalog has PW6 (decision-log *infrastructure*) but no
   object-level "explain this" UX. **~8 cells.**
6. **M13 Search & retrieval / knowledge** per segment — vendor-360, customer-360, collections-interaction
   history ("what was already tried" — an explicit AR leak), payment history, expense policy, catalog/
   contract price, rec/transaction history. Retrieval-as-a-modality is essentially absent from catalog v2.
   **~7 cells.**
7. **M9 Agentic orchestration** as named end-to-end loops — the AP agent, vendor-onboarding agent, morning-
   cash agent, order-to-cash (quote→collect) agent, pay-run agent, expense agent, procure-to-pay agent.
   Catalog has PW7 (doc-chase) and individual steps, but never the composed supervised agent. **~7 cells.**

**C. Specific point capabilities newly named.**
8. **Remittance-advice generation** (to vendor on AP payment / on any money-out) — M6 AP + M6 Payments.
9. **Email/PDF remittance-advice parsing** for cash application — distinct from bank-file/BAI2 (AR-C23).
10. **Pre-send billing-error detection** on AR invoices (wrong price/qty/tax/PO → silent dispute).
11. **Payment-run fraud screen at release** (new payee / unusual amount / positive-pay / ACH-filter as one
    release-time gate) and **payment-status / failed-payment monitoring** and **settlement-date prediction**
    and **rail optimization** — the money-movement segment's own detection/optimization cells beyond SoD.
12. **Vendor-reliability / delivery-risk score** and **vendor-consolidation recommendation** and
    **continuous OFAC re-screen** — vendor-mgmt cells beyond the built W-9/COI/dedupe controls.
13. **Early-pay-discount offer optimization** on the AR side (mirror of the AP discount optimizer).

**Highest-value misses to escalate (the 5 that matter most):**
- **Customer duplicate-detection & merge (Seg 6 M3)** — the built vendor dedupe (EC-1) has no customer twin;
  duplicate customers fragment AR, corrupt DSO, and defeat credit limits. Cheap (mirror existing code), high trust.
- **Payment-run fraud screen at release (Seg 7 M4)** — pairs with the specced BEC control to make the
  money-out path fraud-safe at the exact SoD gate that already exists; highest single-event $ risk.
- **Transactional NL front door (M8, all segments)** — the same pervasive-NL miss the panel was chartered
  to prevent, now on AP/AR/cash/pay, not just JE + reports.
- **Expense-policy / out-of-policy detection (Seg 8 M4)** — the entire employee-spend control surface is
  unbuilt; it is the Ramp/Brex/Expensify parity line and a real leakage/fraud vector.
- **Remittance parse-in / advice-out pair (Seg 5 M1 + Seg 7 M6)** — closes the cash-application matching loop
  (parse payer remittance) and the disbursement loop (send remittance advice); both are pure-labor sinks today.

---

## Per-segment top-3 (build-first, each still needs a Rule-13 FPB behind its gate)

**1. AP / Bills** — (a) line-level extraction + source-doc vault to make intake audit-grade; (b) bill-line AI
coding + cost→job attribution (the suite moat); (c) the **AP agent (M9)** that composes the built pieces
under supervision. *Gates 8/6; identity gate #9 underwrites approval.*

**2. Vendor Management & Compliance** — (a) **BEC / vendor-bank-change** quarantine + dual-control (top-$
fraud, zero coverage); (b) W-9 field extraction + IRS TIN matching; (c) **vendor-onboarding agent (M9)** over
the built compliance gates. *Gate 9 money-movement extension + gate 8.*

**3. Bank & Cash / Bank Feed** — (a) finish the reconciliation controller (per-line check-off/finalize/lock,
close gate); (b) decision-grade forecast (scheduled-outflow overlay + payroll/debt safety alert); (c) the
**morning-cash agent (M9)** + NL cash query on the built dashboard. *Gate 8 + FP&A pillar.*

**4. AR / Invoices** — (a) **pre-send billing-error detection (M4, ⭐NEW)** to stop silent disputes; (b)
item catalog + PO/attachment capture; (c) **order-to-cash agent (M9)** and NL invoice create. *Gate 8.*

**5. Collections & Cash Application** — (a) automated tiered **dunning ladder + AI outreach + promise-to-pay**
(the DSO moat); (b) cash-app approve→post disposition + **email remittance parsing (⭐NEW)**; (c)
**collections-interaction retrieval (M13, ⭐NEW)** to kill double-chasing. *Gates 8/9.*

**6. Customer Management** — (a) **duplicate-customer detection & merge (⭐NEW, mirror of vendor dedupe)**;
(b) credit scoring + limit/hold + re-review-staleness monitoring; (c) **customer-360 (M7) + onboarding/credit
agent (M9)**. *Gate 8/11; the thinnest segment, cheapest mirrors.*

**7. Money Movement / Payments** — (a) **payment-run fraud screen at release (⭐NEW)** on the built SoD gate;
(b) **pay-run agent (M9)** with human release + **remittance-advice generation (⭐NEW)**; (c) **payment-status
/ failed-payment monitoring (⭐NEW)**. *Gate 9.*

**8. Expense & Card Management** — (a) receipt↔card↔bill 3-way matcher + receipt posting path; (b)
**expense-policy / out-of-policy detection (⭐NEW)**; (c) **capture→reimburse expense agent (M9, ⭐NEW)** on the
money-movement spine. *Gate 8; near-greenfield segment.*

**9. Procurement / PO / 3-way** — (a) **PO model in Books** (AP-D1, NEEDS-CENTRAL — the keystone that unblocks
the segment); (b) **3-way/2-way match** on it; (c) **requisition→match procure-to-pay agent (M9, ⭐NEW)** +
encumbrance-vs-budget monitoring. *Gate 11b; designed centrally, never invented by a slice.*

---

*Analysis/spec only. Supplements catalog v2 — it does not supersede it; the ⭐NEW cells above should be folded
into the next catalog revision. No build authorization: every capability must clear its Rule-13 FPB and its
`Prereq:` gate first.*
