# Feature Proof Blueprint — Dealer Pack (equipment-dealer accounting: floor plan, serialized units, OEM warranty & incentives, trade-ins)

**Status:** DRAFT for owner approval (Rule 13). Written 2026-10-20. Docs only — no app code, no migration applied.
**Owner decision (binding):** build a "dealer pack" — the accounting equipment dealers need that a normal small business
doesn't. First real user: a power-equipment dealer client of the Merit Management tenant. The pack is a **generic,
switch-on industry module** for any dealer client (outdoor power / small engine, ag & compact equipment, powersports,
marine, RV, trailers). Nothing about any one client, lender, OEM or DMS is hardcoded.
**Proposed migration:** `169_dealer_pack` (168 reserved; 163–167 access-control work in flight).

**Canon guards (CANON-ANCHOR §1–3):** Books owns the ledger, not the business objects (lenders and OEMs are
`core.vendors`, customers are `core.customers`, models are `core.items`, clients are `core.locations`). Accounts are
referenced **by role** (`core.account_role_keys`), never by number. Account types are ASSET / LIABILITY / EQUITY /
REVENUE / COGS / OPEX / OTHER (no EXPENSE). All money is bigint cents. Everything posts through `postJournalEntry`;
the AI proposes facts, the deterministic engine does the accounting, a human approves. RLS on every table
(`org_id = get_org_id()`) plus client-scope RLS from migration 163. **Not** a revival of the retired chargeback /
burden / cost-allocation engine (§3.6 explains how setup labor is handled without it).
**Cross-references:** 09-COMPETITIVE-FEATURE-MATRIX §3 item 17 ("Dealer pack"), 07-INTEGRATIONS-PLAN (c-Systems rows),
`packages/industry-packs/src/packs/equipment_dealer.ts` (the Projects-side service catalog — vocabulary aligned, not
edited), FPB-bank-reconciliation, FPB-financial-control-exceptions, FPB-invoices, FPB-commissions.

**Source tags used in this brief:** [C] executed document · [E] email in the owner's mailbox · [D] financial report in
Dropbox · [R] repo doc · [W] public web source · [U] unverified industry knowledge, confirm before relying on it ·
**[gap]** not found · **[conflict]** sources disagree (both shown).

---

## 0. The one-paragraph version

An equipment dealer does not buy most of its stock with its own money. A **floor-plan lender** (often the
manufacturer's captive finance company) pays the manufacturer when a serialized unit ships, and the dealer owes the
lender **per unit**: interest after any free-floor period, scheduled **curtailments** (partial paydowns) as the unit
ages, and the **full payoff the moment the unit is sold**. Selling a unit and not paying it off is **"sold out of
trust" (SOT)** — the lender finds it at its periodic **floor check (audit)**, charges penalty interest, puts the
account on **credit hold** and can declare default. Dealers also carry receivables that ordinary businesses don't:
**warranty claims** owed by the manufacturer for repairs done on its behalf, and **manufacturer incentives** (retail
rebates, volume bonuses, co-op advertising, interest subsidies). They take **trade-ins** worth less than the allowance
given, and they manage the business **by department** (new and used whole goods, parts, service, rental). The Dealer
Pack gives any dealer client, once switched on, a **per-unit register** (serial, cost build-up, age), a **floor-plan
subledger** tied to it (flooring, interest, curtailments, payoff-on-sale, SOT detection), **lender statement and audit
reconciliation**, **warranty and incentive receivables** with AI matching of manufacturer credits, **trade-in
accounting**, **departmental P&L tagging**, and file-based **import from the dealer-management system (DMS), lenders and
manufacturers**. Every posting is proposed, balanced, approved and traceable to the unit.

### 0.1 Why now — first client facts

The first client to use the pack is an outdoor power equipment dealer that is a client of the Merit Management tenant.
What we know (none of this is hardcoded — it seeds acceptance tests and onboarding):

| Fact | Source |
|---|---|
| DMS is **c-Systems Infinity** (outdoor power / ag / powersports DMS with its own GL, a GL Interface Wizard and a QuickBooks interface; **no public API found**) | [R] 07-INTEGRATIONS-PLAN rows for c-Systems |
| Prior books were **Sage Intacct, subscription cancelled effective 10/1/2026**; whether data was extracted is open | [R] 07-INTEGRATIONS-PLAN §5 R1 · extract status **[gap]** |
| **[conflict]** The Aug 31, 2026 balance sheet in Dropbox is a QuickBooks Online report ("Total for…" layout, "QuickBooks Tax Holding Account") — so the current working books may be QBO, not Intacct | [D] `/Merit Management/2026/Balance Sheet/August/…Balance Sheet (1).xlsx` vs [R] 07 plan |
| Balance sheet carries **one** "Floor Plan Payable" liability account (no per-lender split), inventory split into **Wholegoods / Used Wholegoods / Parts / Rentals**, plus Customer Deposits, Accrued Commission and Accrued Interest. **No** warranty-receivable or manufacturer-incentive-receivable account appears | [D] same file |
| Floor-plan lender: **Red Iron Acceptance, LLC** (Toro/Exmark captive joint venture, now within Huntington Distribution Finance) | [E] lender emails Jul–Sep 2026 · [W] Toro/TCF JV release |
| Lender terms as stated by the lender: **pay-as-sold** (sold inventory due on sale; weekly payments requested for that week's sales); **interest due by the 15th** monthly; **scheduled payments / open account (parts) due by their due dates, typically the 25th**; audit findings to be resolved in **3–4 calendar days** (other email: **3–5 days**); sold-and-unpaid units unpaid after about **10 days** start accruing interest at **21.9%**; aged inventory at **end of floor-plan terms (typically 2 years)** needs a repayment plan; **late fees**; **orders are not released while the account is past due** | [E] |
| The lender floor-plans **parts on "Open Account"** (non-serialized invoices with a scheduled due date), not only serialized whole goods | [E] scheduled-payment list, collateral type "Open Account" |
| Lender audit lines carry: lender invoice #, invoice date, **serial #**, **model #**, original balance, current balance, code, disposition date, days | [E] |
| Lender audits in **Apr 2026, Jul 2026 and Sep 2026** each found **sold-and-unpaid units**; the April audit led to a **credit hold** and a payment-plan discussion | [E] |
| The lender **dated sold-out-of-trust units from the manufacturer's warranty-registration dates** — i.e. it used retail registration as proof of sale | [E] |
| Other floor-plan lenders, other manufacturer lines, how warranty claims and rebates are handled today, who in the store files them | **[gap]** |

The lesson that shapes v1: the dealer's books did not know which floored units were sold. The lender did. The pack
must make "sold, not yet paid off" visible **the day the sale is recorded**, not at the next audit.

## 1. Purpose, personas, definition of done

**Purpose.** Let a bookkeeper keep a dealer's floor plan, units, warranty and incentive receivables and trade-ins
right **every day**, with the system — not the lender's auditor — catching sold-out-of-trust units, missed
curtailments and unreconciled statements; and give the owner a departmental P&L that matches how dealers run.

| Persona | Job in the pack | Today (first client) |
|---|---|---|
| **Bookkeeper** (primary; often a firm's accounting specialist working several clients) | Imports DMS unit and deal files and lender/OEM statements; reviews AI-proposed postings; pays off sold units; reconciles lender statements; works the exception queue | Learns of SOT units from lender emails after audits [E]; one floor-plan payable account, no per-unit subledger [D] |
| **Controller** | Approves postings above thresholds and lender reconciliations; signs off month-end ties (subledger = GL); owns the role map and policies | Manual tie-outs **[gap]** |
| **Owner / general manager** | Sees floor-plan position, SOT risk, unit aging, warranty and incentive cash owed, departmental P&L; approves payment plans | Lender emails escalated to the owner [E] |
| **Parts & service manager** (approver) | Approves warranty claim write-offs and resubmissions; owns claim deadlines; approves setup/PDI cost added to units | **[gap]** |
| **Sales manager / whole-goods manager** (approver) | Approves trade-in ACV and over-allowance on a deal; owns aged-unit decisions (discount, demo, return) | **[gap]** |

**Definition of done (Rule 3 + Rule 13).** The pack is *Complete* when every acceptance criterion in §10 passes on a
real dealer client: switched on per client without code changes; units, notes and claims load from files; every money
event posts a balanced JE through `postJournalEntry` with the unit/claim reference and department; the floor-plan
subledger and unit register **tie to the GL to the cent** at month end; SOT, curtailment and statement-variance
exceptions fire in `/exceptions`; every screen has loading / empty / populated / error states; client-scope RLS and
capabilities enforced; verifier, chrome-auditor and security GO.

## 2. Scope — v1 vs later

### 2.1 v1 (build now)

| # | Feature | Why v1 |
|---|---|---|
| V1 | **Floor-plan lines, programs and notes**: lender lines with limits; programs with free-floor days, rate, curtailment schedule, payoff terms (pay-as-sold or N days), max term; one note per floored unit or open-account invoice | The first client's biggest live risk is the floor plan [E] |
| V2 | **Flooring, interest accrual, curtailments, payoff on sale** posting flows | Core floor-plan accounting |
| V3 | **Sold-out-of-trust detection** from three signals: sale posted in Books, deal in the DMS import, manufacturer warranty registration date | The lender used warranty registrations to date SOT [E] |
| V4 | **Serialized unit register** with cost build-up (base invoice, freight, setup/PDI, accessories, recon), status and aging; new, used, demo, rental-ready, consignment flag | Floor plan and unit gross can't exist without per-unit cost (see canon question Q1) |
| V5 | **Lender statement and floor-check (audit) reconciliation**, line by line, with sign-off | Statements and audits are how the lender sees the dealer |
| V6 | **Manufacturer warranty claims receivable** (labor at warranty rate, parts at cost plus markup, sublet, freight), statement-credit matching, short-pays, rejections, write-offs | Real cash; easy to lose; deadlines |
| V7 | **Manufacturer incentives receivable** (retail rebate, dealer rebate / volume bonus, holdback, co-op, spiff, interest subsidy) with the right accounting treatment per type | Real cash; easy to lose |
| V8 | **Trade-ins**: ACV vs allowance, over/under-allowance, lien payoff, used unit created at ACV | Every whole-goods deal can include one |
| V9 | **Departmental P&L tagging**: dealer department roles mapped to the client's departments; every pack posting carries the department | How dealers manage; service absorption KPI |
| V10 | **Import**: file-based first (DMS units/deals/warranty CSV-XLSX; lender statements and audits as PDF/XLSX/email body; manufacturer statements) with AI parsing; API only where one exists | c-Systems has no public API [R] |
| V11 | **Controls, reports, widgets** in §6–7; **borrowing-base** input that excludes floored collateral | Lenders and owners ask for these first |

### 2.2 Later (with reasons)

| Feature | Why later |
|---|---|
| Rental fleet as fixed assets (rent-to-own, utilization, depreciation by hours) | Fixed-asset module exists; rental is a separate department flow. v1 only tracks a unit's move from inventory to rental at cost |
| Consumer retail-finance accounting (lender-funded receivable, dealer reserve / participation income, chargebacks) | Matrix §3 item 20 covers it generically for all trades; the dealer pack reuses it when built |
| Service contracts / extended warranties sold to customers (deferred revenue, cancellations) | Rev-rec engine covers deferral; low volume for first client **[gap]** |
| Quantity-level parts management (bins, min/max, special orders, returns to the manufacturer) | Reserved for MeritInventory (canon); the DMS stays master for parts |
| Direct API connectors to DMSs and lender portals | No public API for the first client's DMS [R]; build per vendor once access exists |
| Automatic payoff release (money leaves without a human) | v1 proposes payoff payments; a human releases (canon §3 money-movement) |
| Multi-store unit transfers between clients with intercompany entries | Intercompany engine exists; add when a multi-store dealer signs |
| Manufacturer program rule engine that auto-computes every incentive | v1 accrues incentives from program + deal facts entered/imported; AI drafts program rules for approval |

## 3. Workflows and GL effect (by account role)

### 3.0 Account roles

Role keys follow the existing `core.account_role_keys` convention (UPPER_SNAKE, scope ORG or LOCATION, nullable
`default_account_number`). **No default account numbers are assumed** (the 137-account template may not have them):
the pack's setup step maps each role to one of the client's accounts and **refuses to switch on** until every
required role is mapped (a fallback counts as mapped). Existing roles reused: `AR_CONTROL`, `AP_CONTROL`,
`OPERATING_BANK`, `CUSTOMER_DEPOSITS` (mig 140), `INVENTORY_ASSET` / `INVENTORY_COGS` (parts, mig 101),
`INTEREST_EXPENSE` (mig 149), `ACCRUED_EXPENSES`, `SALES_TAX_PAYABLE`.

| New role key | Type | Scope | Required? | Fallback if unmapped | Default department role |
|---|---|---|---|---|---|
| `WHOLE_GOODS_INVENTORY` | ASSET | LOCATION | yes | — | WG_NEW |
| `USED_WHOLE_GOODS_INVENTORY` | ASSET | LOCATION | yes | `WHOLE_GOODS_INVENTORY` | WG_USED |
| `RENTAL_INVENTORY` | ASSET | LOCATION | no | `WHOLE_GOODS_INVENTORY` | RENTAL |
| `FLOOR_PLAN_PAYABLE` | LIABILITY | LOCATION | yes (a line may override with its own account) | — | — |
| `FLOOR_PLAN_INTEREST_ACCRUED` | LIABILITY | LOCATION | yes | `ACCRUED_EXPENSES` | — |
| `FLOOR_PLAN_INTEREST` | OPEX or OTHER (tenant's choice by mapping) | ORG | yes | `INTEREST_EXPENSE` | WG_NEW / WG_USED by unit |
| `FLOOR_PLAN_FEES` | OPEX | ORG | no | `FLOOR_PLAN_INTEREST` | as above |
| `WHOLE_GOODS_SALES` | REVENUE | ORG | yes | — | WG_NEW |
| `WHOLE_GOODS_COGS` | COGS | ORG | yes | — | WG_NEW |
| `USED_GOODS_SALES` | REVENUE | ORG | no | `WHOLE_GOODS_SALES` | WG_USED |
| `USED_GOODS_COGS` | COGS | ORG | no | `WHOLE_GOODS_COGS` | WG_USED |
| `TRADE_IN_OVER_ALLOWANCE` | REVENUE (contra; debit-normal) | ORG | yes | — | WG_NEW |
| `TRADE_LIEN_PAYOFF` | LIABILITY | LOCATION | yes | — | — |
| `SETUP_LABOR_CAPITALIZED` | COGS (contra) | ORG | no | — (setup labor not capitalized if unmapped; warns) | SERVICE |
| `INVENTORY_WRITEDOWN` | COGS | ORG | no | `WHOLE_GOODS_COGS` | WG_NEW / WG_USED |
| `WARRANTY_RECEIVABLE` | ASSET | LOCATION | yes | — | — |
| `WARRANTY_LABOR_SALES` | REVENUE | ORG | yes | — | SERVICE |
| `WARRANTY_PARTS_SALES` | REVENUE | ORG | no | `WARRANTY_LABOR_SALES` | PARTS |
| `WARRANTY_POLICY_EXPENSE` | OPEX | ORG | yes | — | SERVICE |
| `OEM_INCENTIVE_RECEIVABLE` | ASSET | LOCATION | yes | — | — |
| `CO_OP_ADVERTISING_RECOVERY` | OPEX (contra) | ORG | no | — (co-op treated as cost reduction if unmapped) | ADMIN |

Debit/credit direction is still derived from account type by the engine; the tables below state the economic
effect. Sales tax, payment rails and customer payments use the existing invoice and payment flows unchanged.

**Illustrative unit used in every example** (figures are illustrative, not first-client data): new unit U-1,
manufacturer invoice **$10,000.00** (1,000,000¢), carrier freight **$250.00** (25,000¢), setup/PDI **$150.00**
(15,000¢: 9,000¢ labor at actual cost + 6,000¢ parts at cost). Program: 90 free-floor days, then 9.00% simple
interest (actual/365), curtailment 10% of original principal at day 180, payoff due on sale (pay-as-sold).

### 3.1 Flooring (unit received, lender pays the manufacturer)

1. The manufacturer ships; the lender's flooring notice / statement line (or the DMS receiving file) arrives.
2. The import (or AI parser, §5) proposes: a `dealer_units` row (serial, model, make, condition NEW, status
   IN_STOCK), a `floor_plan_notes` row (line, program, lender invoice #, original principal, floored date, free-floor
   end, maturity = floored date + program max term) and a FLOOR transaction.
3. The bookkeeper approves (or the tenant's autonomy dial auto-approves exact matches, §5). The engine posts:

| Line | Role | Debit ¢ | Credit ¢ |
|---|---|---:|---:|
| 1 | `WHOLE_GOODS_INVENTORY` (unit U-1, dept WG_NEW) | 1,000,000 | |
| 2 | `FLOOR_PLAN_PAYABLE` (line, note) | | 1,000,000 |

**There is no AP bill for a floored unit.** If the manufacturer's invoice also arrives in the AP inbox, the AP intake
recognizes the serial / lender-paid flag and links it to the note instead of creating a bill (detector DL-13 catches
misses). Freight billed separately by a carrier is an ordinary AP bill whose line is assigned to the unit:

| `WHOLE_GOODS_INVENTORY` (U-1, cost type FREIGHT) | 25,000 | |
|---|---:|---:|
| `AP_CONTROL` (carrier) | | 25,000 |

Units paid in cash (not floored) are created with no note; they are "owned" units.

### 3.2 Interest accrual and lender interest billing

1. Month end: the scheduler (mig 162) computes interest per open note for interest-bearing days only (after
   free-floor end), `principal × rate_bps / 10,000 × days / 365`, rounded half-up to the cent **once per note per
   period**, and proposes one INTEREST_ACCRUAL batch JE with a line per department.
2. Example — 30 interest-bearing days on 1,000,000¢ at 900 bps: 1,000,000 × 0.09 × 30 / 365 = 7,397.26 → **7,397¢**.

| `FLOOR_PLAN_INTEREST` (U-1, dept WG_NEW) | 7,397 | |
|---|---:|---:|
| `FLOOR_PLAN_INTEREST_ACCRUED` | | 7,397 |

3. The lender bills interest monthly (first client: due by the 15th [E]) and usually debits the bank. When the lender
   bill/debit of **7,410¢** is matched on the bank feed, the engine clears the accrual and books the difference:

| `FLOOR_PLAN_INTEREST_ACCRUED` | 7,397 | |
|---|---:|---:|
| `FLOOR_PLAN_INTEREST` (true-up) | 13 | |
| `OPERATING_BANK` | | 7,410 |

   A true-up above the tenant tolerance (default the greater of $25 or 2% of the line's billed interest) raises DL-9
   instead of posting silently. Late fees and audit fees post to `FLOOR_PLAN_FEES`.

### 3.3 Curtailments

1. On flooring, the program's curtailment schedule creates `floor_plan_curtailments` rows (e.g. day 180: 10% of
   original = 100,000¢).
2. DL-2 warns 7 days before due; the bookkeeper proposes payment (or matches the lender's auto-debit on the feed).
3. On payment — **inventory cost does not change**, only the debt:

| `FLOOR_PLAN_PAYABLE` (note U-1) | 100,000 | |
|---|---:|---:|
| `OPERATING_BANK` | | 100,000 |

### 3.4 Unit sale and payoff on sale

1. The sale reaches Books either as a Books invoice with the unit on a line, or as a DMS deal import (§8). Either way
   a `dealer_unit_sales` row links unit → invoice → customer and the unit becomes SOLD.
2. Revenue and cost (price 1,350,000¢; customer had paid a 100,000¢ deposit; tax handled by existing flows):

| `CUSTOMER_DEPOSITS` (applied, mig 140 flow) | 100,000 | |
|---|---:|---:|
| `AR_CONTROL` | 1,250,000 | |
| `WHOLE_GOODS_SALES` (dept WG_NEW) | | 1,350,000 |
| `WHOLE_GOODS_COGS` (U-1) | 1,040,000 | |
| `WHOLE_GOODS_INVENTORY` (U-1: 1,000,000 + 25,000 + 15,000) | | 1,040,000 |

3. In the same transaction the note moves to **SOLD_UNPAID** with `payoff_due_date` = sale date + the program's payoff
   days (0 for pay-as-sold) and a payoff of the remaining principal (1,000,000 − 100,000 curtailment = **900,000¢**) is
   **proposed** into the next payment batch. The SOT clock (DL-1) starts now — not at the lender's next audit.
4. A human releases the payoff (existing payment rails, preparer ≠ approver). On payment / bank match:

| `FLOOR_PLAN_PAYABLE` (note U-1) | 900,000 | |
|---|---:|---:|
| `OPERATING_BANK` | | 900,000 |

   The note becomes PAID_OFF. Accrued interest through the payoff date is accrued with the month-end batch.

### 3.5 Trade-in

Same sale, now with a trade: allowance **300,000¢**, appraised actual cash value (ACV) **250,000¢**, the customer still
owes **120,000¢** to their own lender on the trade (lien), no deposit. Over-allowance = 50,000¢.

1. The salesperson / DMS deal supplies allowance, lien and ACV; the sales manager approves the ACV (approval threshold
   setting). A used unit (condition USED) is created at the recorded value.
2. Valuation policy (per client): **default `LOWER_OF_ACV_AND_ALLOWANCE`** — the used unit is recorded at the lower of
   ACV and allowance; over-allowance reduces the new-unit gross; under-allowance is not booked as a gain. Alternative
   `ACV` records the unit at ACV and credits under-allowance to `TRADE_IN_OVER_ALLOWANCE`.

| `USED_WHOLE_GOODS_INVENTORY` (new used unit, dept WG_USED) | 250,000 | |
|---|---:|---:|
| `TRADE_IN_OVER_ALLOWANCE` (dept WG_NEW) | 50,000 | |
| `AR_CONTROL` (1,350,000 − 300,000 + 120,000) | 1,170,000 | |
| `WHOLE_GOODS_SALES` | | 1,350,000 |
| `TRADE_LIEN_PAYOFF` (payable to the customer's lender) | | 120,000 |
| **Totals** | **1,470,000** | **1,470,000** |

3. The lien payoff is proposed for payment (DR `TRADE_LIEN_PAYOFF` 120,000 / CR `OPERATING_BANK` 120,000); DL-11 flags
   a lien unpaid after N days (default 10) because the dealer cannot get clean title until it is paid.

### 3.6 Setup / PDI and other unit cost additions

Cost types: BASE_INVOICE, FREIGHT, SETUP_PDI, ACCESSORY, RECON (used units), OTHER, plus negative REBATE_REDUCTION and
WRITE_DOWN. Each `dealer_unit_costs` row points at its source (floor-plan note, AP bill line, internal repair order,
incentive, manual JE) and its posted `gl_entry_id`; the unit's cost is the sum of posted rows.

Setup labor is capitalized **at actual cost reported by the DMS internal repair order** (hours × the tech's actual pay
rate, or the DMS's internal-RO cost) — **no overhead rate, no burden, no labor classification, no department
chargeback** (canon §2 guard; reviewer checks). Parts used come out of parts inventory at cost:

| `WHOLE_GOODS_INVENTORY` (U-1, SETUP_PDI) | 15,000 | |
|---|---:|---:|
| `SETUP_LABOR_CAPITALIZED` (dept SERVICE) | | 9,000 |
| `INVENTORY_ASSET` (parts) | | 6,000 |

If `SETUP_LABOR_CAPITALIZED` is unmapped, labor stays in wages and only parts are capitalized (warning on the unit).

### 3.7 Unit status changes

| Event | GL effect |
|---|---|
| Demo (stays inventory) | No entry; unit flagged DEMO; if the program curtails demos, a curtailment row is created |
| Moved to rental | DR `RENTAL_INVENTORY` / CR `WHOLE_GOODS_INVENTORY` at cost (rental depreciation is Later) |
| Aged-unit write-down to net realizable value (controller-approved) | DR `INVENTORY_WRITEDOWN` / CR `WHOLE_GOODS_INVENTORY`; cost row WRITE_DOWN |
| Returned to manufacturer / repurchase, lender credits the note | DR `FLOOR_PLAN_PAYABLE` / CR `WHOLE_GOODS_INVENTORY` (difference to `INVENTORY_WRITEDOWN`) |
| Consignment unit | Tracked in the register with `is_consignment`; **no** balance-sheet entry and no note; on sale the consignor payable flows through AP |
| Parts floored on "open account" (first client's lender does this [E]) | DR `INVENTORY_ASSET` / CR `FLOOR_PLAN_PAYABLE` on a note with collateral OPEN_ACCOUNT and a scheduled due date; paid like a curtailment |

### 3.8 Manufacturer warranty claim

The repair happens in service (the Projects-side `warranty_repair` job type and `oem_claim_number` /
`claim_deadline` fields in the equipment-dealer industry pack). Books owns the money side.

1. Claim created from the DMS warranty-claim export or the closed warranty repair order: labor 2.0 h × warranty labor
   rate 9,500¢ = **19,000¢**; parts at cost 8,000¢ reimbursed at cost + 30% = **10,400¢**; sublet 0; freight 0;
   claimed **29,400¢**. The DB checks that claimed = labor + parts + sublet + freight + other.
2. On SUBMITTED (or on repair-order close, per client setting `warranty_recognition = ON_RO_CLOSE | ON_SUBMIT`):

| `WARRANTY_RECEIVABLE` (claim, OEM) | 29,400 | |
|---|---:|---:|
| `WARRANTY_LABOR_SALES` (dept SERVICE) | | 19,000 |
| `WARRANTY_PARTS_SALES` (dept PARTS) | | 10,400 |
| `INVENTORY_COGS` (parts, dept PARTS) | 8,000 | |
| `INVENTORY_ASSET` (parts) | | 8,000 |

3. The manufacturer pays most claims as **credits on its statement** against the dealer's parts account [U]. The OEM
   statement is imported (§5 A2); the AI matcher proposes claim ↔ credit pairs (§5 A3). Credit of **27,000¢**
   (labor cut to 1.8 h): the claim becomes PARTIAL; the parts & service manager either **resubmits** the 2,400¢ or
   **accepts the short-pay**, which posts:

| `AP_CONTROL` (manufacturer vendor) | 27,000 | |
|---|---:|---:|
| `WARRANTY_POLICY_EXPENSE` (accepted short-pay, dept SERVICE) | 2,400 | |
| `WARRANTY_RECEIVABLE` | | 29,400 |

4. A cash/ACH payment instead posts DR `OPERATING_BANK` / CR `WARRANTY_RECEIVABLE`. A **rejection** written off
   (approver required, the industry pack's `warranty_writeoff` approval) posts DR `WARRANTY_POLICY_EXPENSE` / CR
   `WARRANTY_RECEIVABLE`. A later **debit** (post-audit chargeback) posts DR `WARRANTY_POLICY_EXPENSE` / CR `AP_CONTROL`
   and links to the original claim.

### 3.9 Manufacturer incentives

Each `oem_programs` row carries an **accounting treatment**; the treatment, not the name, decides the GL effect.

| Treatment | Typical program types | GL at accrual | Basis |
|---|---|---|---|
| `TRANSACTION_PRICE` | Retail (consumer) rebate the manufacturer pays on the customer's behalf | Part of the sale: DR `OEM_INCENTIVE_RECEIVABLE` instead of AR | Consideration from a third party for the customer's purchase is part of the transaction price (ASC 606) [U] |
| `COST_REDUCTION` | Dealer rebate, volume / target bonus, holdback, floor-plan support | DR `OEM_INCENTIVE_RECEIVABLE` / CR `WHOLE_GOODS_COGS` if the unit is sold, CR `WHOLE_GOODS_INVENTORY` (cost row REBATE_REDUCTION) if still in stock | Consideration from a vendor reduces cost of the goods (ASC 705-20) [U] |
| `EXPENSE_REIMBURSEMENT` | Co-op advertising for specific, incremental, identifiable costs; interest subsidy the dealer paid first | CR `CO_OP_ADVERTISING_RECOVERY` or `FLOOR_PLAN_INTEREST` | Reimbursement of a specific cost [U] |
| `PASS_THROUGH` | Salesperson spiffs paid through the dealer | CR `ACCRUED_EXPENSES`; paid via the commissions/payroll seam (FPB-commissions) | Not dealer income |

Spiffs paid by the manufacturer directly to the employee and interest subsidies paid by the manufacturer directly to
the lender (free-floor) create **no dealer entry**; they are recorded on the program for reporting only.

Example — retail rebate 50,000¢ on U-1's sale (instead of §3.4's AR line): DR `AR_CONTROL` 1,300,000; DR
`OEM_INCENTIVE_RECEIVABLE` 50,000 / CR `WHOLE_GOODS_SALES` 1,350,000. Dealer volume rebate 20,000¢ on the sold unit:
DR `OEM_INCENTIVE_RECEIVABLE` 20,000 / CR `WHOLE_GOODS_COGS` 20,000. Settlement by statement credit: DR `AP_CONTROL` /
CR `OEM_INCENTIVE_RECEIVABLE`; by cash: DR `OPERATING_BANK` / CR `OEM_INCENTIVE_RECEIVABLE`. Short-pays and rejections
follow the warranty pattern, written off to the same account the accrual credited (sales, COGS or the expense).

### 3.10 Lender statement and floor-check (audit) reconciliation

1. Import the lender's monthly statement or audit report (PDF, XLSX, CSV or the body of the lender's email) → a
   `lender_statements` row (kind STATEMENT | AUDIT | PAYOFF_QUOTE) with one line per lender invoice / serial.
2. Deterministic matcher pairs each line to a note by lender invoice #, then serial, then model + amount, and labels
   it MATCHED, VARIANCE (balance differs), LENDER_ONLY (lender shows a note Books doesn't have) or BOOKS_ONLY.
3. Audit findings coded sold-and-unpaid (e.g. "NP", first client [E]) are compared to Books: a unit the lender calls
   SAU that Books still shows IN_STOCK is a **Books error** (sale not recorded) and opens a task to record the sale.
4. Statement totals must foot to the statement footer before matching starts (parser output is rejected otherwise).
5. The preparer resolves variances (post a missing flooring, correct a payoff date, dispute with lender); the
   controller **signs off** (preparer ≠ approver). A signed-off reconciliation for every active line is a close
   checklist item; a variance over tolerance raises DL-8.

### 3.11 Departmental tagging

The client maps the pack's **department roles** — WG_NEW, WG_USED, PARTS, SERVICE, RENTAL, ADMIN — to its own
`core.departments` rows (the pack suggests names; nothing is created without the client's choice). Every pack posting
line carries `department_id` from that map (table in §3.0); posting fails closed if a required department role is
unmapped and the client's dimension rules require departments.

## 4. Data model proposal

### 4.1 Principles

- All new tables are **Books-owned, `public` schema**, each with `org_id uuid not null default get_org_id()` and the
  owning client's **`location_id uuid not null references core.locations(id)`**. RLS on with the house pattern
  (`org_isolation` using/with check `org_id = get_org_id()` + `service_write` for service_role); the migration ends
  with `select core.apply_client_scope_rls();` so the 163 client-scope policies attach automatically (the guard test
  insists every client-owned table is covered).
- Business objects are referenced, never copied: lenders, manufacturers, carriers and lienholders are `core.vendors`;
  buyers are `core.customers`; models may reference `core.items`; departments are `core.departments`.
- Money columns are `bigint` cents; rates are integer **basis points**; quantities/hours `numeric`.
- Every posting row carries `gl_entry_id` and a unique **idempotency key** so re-running an import or the month-end
  accrual never double-posts (same pattern as mig 064).
- Status workflows are text + CHECK (schema-contract test covers every literal the code writes).
- **Reuse, don't fork:** floor-plan lines optionally link to `debt_instruments` (mig 083) so the debt register,
  covenants and the lender view see them; payoffs and curtailments leave through the existing payment batch / bank
  rails; customer deposits use mig 140; parts stay in mig 101 `inventory_items`; exceptions use `ai_decisions` →
  `/exceptions`; scheduled jobs use the mig 162 scheduler; documents use the existing document store.

### 4.2 Canon question — serialized units vs reserved MeritInventory

The suite contract reserves "UOM / serialization / lot / on-hand / valuation" for the future **MeritInventory**
module ("do not build now"). `dealer_units` is proposed as a **Books-owned financial subledger** — like the fixed-asset
or debt register — whose job is cost capitalization, collateral and lender tie-out, not stock management: no bins, no
transfers, no counts, no pick lists, no on-hand quantities. The DMS stays the operational master. When MeritInventory
ships, `dealer_units` becomes the Books side of its serialized item (FK added, Books keeps cost and floor-plan
columns). **Owner ruling needed (Q1).**

### 4.3 Tables

| Table | Purpose | Key columns | Key constraints |
|---|---|---|---|
| `dealer_pack_settings` | Pack switched on per client + policies | `location_id` (unique per org), `enabled`, `enabled_at/by`, `dms_system`, `trade_valuation_policy` (LOWER_OF_ACV_AND_ALLOWANCE \| ACV \| ALLOWANCE), `warranty_recognition` (ON_RO_CLOSE \| ON_SUBMIT), `sot_grace_days` (default 2), `aging_buckets int[]` (default {90,180,270,365}), `term_warning_days` (60), `interest_tolerance_cents`, `statement_tolerance_cents` (100), `auto_match_min_confidence_bps` | `enabled = true` only if role map complete (enforced by enable route + DB function check) |
| `dealer_department_map` | Department roles → client departments | `location_id`, `dept_role` (WG_NEW…ADMIN), `department_id` | unique (location_id, dept_role) |
| `floor_plan_lines` | A lender credit line for one client | `lender_vendor_id`, `name`, `credit_limit_cents`, `liability_account_id` (nullable override of `FLOOR_PLAN_PAYABLE`), `interest_due_day`, `scheduled_payment_day`, `statement_day`, `debt_instrument_id` (nullable FK mig 083), `status` (ACTIVE \| SUSPENDED \| CREDIT_HOLD \| CLOSED) | limit ≥ 0; days 1–31 |
| `floor_plan_programs` | Rate/term plan under a line (often per manufacturer) | `line_id`, `oem_vendor_id`, `name`, `free_floor_days`, `rate_type` (FIXED \| INDEX_PLUS), `rate_bps`, `index_name`, `spread_bps`, `sau_penalty_rate_bps`, `payoff_terms` (PAY_AS_SOLD \| DAYS_AFTER_SALE), `payoff_days`, `max_term_days`, `curtailment_schedule jsonb` ([{after_days, pct_bps \| amount_cents}]), `effective_from/to` | jsonb shape validated; rate ≥ 0 |
| `dealer_units` | Serialized unit register (§4.2) | `serial_number`, `vin_hin`, `stock_number`, `make_vendor_id`, `model`, `model_year`, `item_id`, `condition` (NEW \| USED \| DEMO \| RENTAL), `is_consignment`, `status` (ON_ORDER \| IN_TRANSIT \| IN_STOCK \| SOLD \| DELIVERED \| RENTAL \| RETURNED \| WRITTEN_OFF \| VOID), `received_date`, `sold_date`, `warranty_registered_date`, `cost_cents` (maintained from posted cost rows), `department_role`, `source` (DMS \| LENDER \| MANUAL \| TRADE_IN), `external_ref` | unique (org_id, location_id, make_vendor_id, serial_number) where status ≠ VOID; sold_date required when SOLD |
| `dealer_unit_costs` | Cost build-up | `unit_id`, `cost_type`, `amount_cents` (negative only for REBATE_REDUCTION / WRITE_DOWN), `source_type` (FLOOR_PLAN_NOTE \| BILL_LINE \| INTERNAL_RO \| INCENTIVE \| JE \| TRADE_IN), `source_id`, `status` (PROPOSED \| POSTED \| VOID), `gl_entry_id`, `idempotency_key` | unique idempotency_key; sign CHECK by cost_type |
| `floor_plan_notes` | One financed unit or open-account invoice | `line_id`, `program_id`, `unit_id` (null for OPEN_ACCOUNT), `collateral_type` (WHOLE_GOOD \| OPEN_ACCOUNT \| OTHER), `lender_invoice_number`, `floored_date`, `original_principal_cents`, `principal_balance_cents`, `free_floor_end_date`, `maturity_date`, `scheduled_due_date`, `status` (OPEN \| SOLD_UNPAID \| PAID_OFF \| IN_DEFAULT \| RETURNED \| VOID), `payoff_due_date`, `sold_detected_by` (BOOKS_SALE \| DMS_DEAL \| WARRANTY_REG \| LENDER_AUDIT) | unique (line_id, lender_invoice_number, coalesce(unit_id)); 0 ≤ balance ≤ original; unit required when WHOLE_GOOD |
| `floor_plan_transactions` | Every money event on a note | `note_id`, `txn_type` (FLOOR \| CURTAILMENT \| PAYOFF \| INTEREST_ACCRUAL \| INTEREST_BILLED \| INTEREST_PAID \| FEE \| ADJUSTMENT \| REVERSAL), `txn_date`, `principal_cents`, `interest_cents`, `fee_cents`, `status`, `gl_entry_id`, `bank_transaction_id`, `payment_id`, `idempotency_key` | unique idempotency_key; posted rows immutable (reverse to correct, mig 153 pattern) |
| `floor_plan_curtailments` | Schedule | `note_id`, `due_date`, `amount_cents`, `status` (DUE \| PAID \| WAIVED \| MISSED), `paid_txn_id` | amount > 0 |
| `lender_statements` / `lender_statement_lines` | Statement, audit, payoff quote + lines | header: `line_id`, `kind`, `statement_date`, `document_id`, `footer_principal_cents`, `footer_interest_cents`, `footer_fees_cents`, `status` (IMPORTED \| MATCHING \| PREPARED \| APPROVED), `prepared_by`, `approved_by`; lines: `lender_invoice_number`, `serial_number`, `model`, `original_cents`, `current_cents`, `interest_cents`, `lender_code`, `disposition_date`, `days`, `matched_note_id`, `match_status`, `variance_cents`, `resolution` | CHECK prepared_by ≠ approved_by; lines must foot to header before PREPARED |
| `dealer_unit_sales` | Unit sale (deal) linking unit, invoice and trade | `unit_id`, `invoice_id`, `customer_id`, `sale_date`, `sale_price_cents`, `deposit_applied_cents`, `retail_rebate_cents`, `trade_in_id`, `retail_finance_vendor_id` (Later accounting), `source`, `external_deal_ref`, `status`, `gl_entry_id` | one non-void sale per unit |
| `trade_ins` | Trade-in appraisal and accounting | `sale_id`, `customer_id`, `used_unit_id`, `allowance_cents`, `acv_cents`, `recorded_value_cents`, `over_allowance_cents` (generated), `lien_payoff_cents`, `lienholder_vendor_id`, `lien_paid_txn_id`, `appraised_by`, `approved_by`, `status` | all ≥ 0; recorded value follows policy (CHECK by policy snapshot) |
| `warranty_claims` | Claim receivable | `oem_vendor_id`, `oem_claim_number`, `dealer_claim_ref`, `repair_order_ref`, `job_id` (core.jobs, nullable), `unit_id` / `serial_number`, `customer_id`, `failure_date`, `repair_date`, `submitted_date`, `filing_deadline`, `labor_hours`, `labor_rate_cents`, `labor_cents`, `parts_cost_cents`, `parts_markup_bps`, `parts_cents`, `sublet_cents`, `freight_cents`, `other_cents`, `claimed_cents`, `approved_cents`, `settled_cents`, `status` (DRAFT \| SUBMITTED \| PARTIAL \| PAID \| REJECTED \| RESUBMITTED \| WRITTEN_OFF \| DEBITED), `rejection_reason`, `gl_entry_id` | claimed = sum of parts (CHECK); settled ≤ claimed unless DEBITED adjustments |
| `oem_programs` | Incentive programs | `oem_vendor_id`, `program_code`, `name`, `program_type`, `treatment`, `start_date`, `end_date`, `claim_deadline_days`, `rules jsonb`, `source_document_id`, `status` (DRAFT \| ACTIVE \| EXPIRED) | AI-drafted programs stay DRAFT until approved |
| `oem_incentive_claims` | Incentive receivable | `program_id`, `unit_id`, `sale_id`, `earned_date`, `claim_deadline`, `accrued_cents`, `claimed_cents`, `settled_cents`, `status` (ACCRUED \| SUBMITTED \| PARTIAL \| PAID \| REJECTED \| WRITTEN_OFF), `gl_entry_id` | settled ≤ claimed |
| `oem_statements` / `oem_statement_lines` | Manufacturer statement credits/debits | lines: `line_type` (WARRANTY_CREDIT \| INCENTIVE_CREDIT \| DEBIT \| PARTS_INVOICE \| OTHER), `reference`, `serial_number`, `amount_cents`, `matched_warranty_claim_id`, `matched_incentive_claim_id`, `match_status`, `ai_decision_id`, `settlement_gl_entry_id` | a line settles at most one claim; totals foot to header |
| `dealer_import_batches` | Every file import | `source_system`, `file_kind` (UNITS \| DEALS \| WARRANTY \| LENDER_STATEMENT \| LENDER_AUDIT \| OEM_STATEMENT \| PROGRAMS \| OPENING), `document_id`, `row_count`, `accepted_count`, `rejected_count`, `errors jsonb`, `status` | rows keep `import_batch_id` for undo of an unposted batch |

**Views (security_invoker, mig 066 pattern):** `v_floor_plan_position` (per line/program: principal, accrued interest,
curtailments due, SOT count/amount, utilization), `v_unit_aging`, `v_dealer_subledger_tieout` (subledger totals vs GL
balances by role), `v_warranty_aging`, `v_incentive_aging`.

**New `entry_type_enum` values** (same pattern as mig 055): `FLOOR_PLAN`, `FLOOR_PLAN_INTEREST`, `UNIT_SALE`,
`TRADE_IN`, `WARRANTY_CLAIM`, `OEM_INCENTIVE`, `UNIT_COST`. The schema guard test asserts every posted type exists.

**Opening balances (go-live):** the onboarding import loads open notes from the lender's latest statement and units
from the DMS stock list, then posts **no** GL (balances come from the migrated trial balance) but must **tie**: open
note principal per line = mapped `FLOOR_PLAN_PAYABLE` balance, and in-stock unit cost = `WHOLE_GOODS_INVENTORY` +
`USED_WHOLE_GOODS_INVENTORY` balances. A difference blocks enabling until a reconciling JE is approved.

## 5. AI features (via the gateway)

Every call goes through `runAiGateway` (`packages/core-ai/src/gateway.ts`): metered to `core.ai_usage_log`, counted
against the tenant's combined monthly budget, no module-held key. Every output is logged to `ai_decisions` with input
summary, reasoning and confidence. **The AI proposes facts (parsed lines, matches, classifications); the deterministic
engine builds every debit and credit; a human approves** unless the tenant turns a specific task's autonomy dial up.

| # | Feature | Input → output | Default autonomy | May be raised to |
|---|---|---|---|---|
| A1 | **Lender statement / audit parser** | PDF, XLSX, CSV or the lender's email body (the first client's lender sends audit tables inline [E]) → `lender_statement_lines` | Propose; rejected outright if lines don't foot to the footer | Auto-import when footing passes (matching and sign-off stay human) |
| A2 | **Manufacturer statement / credit-memo parser** | OEM statement or credit memo → `oem_statement_lines` typed as warranty credit, incentive credit, debit, parts invoice | Propose | Auto-import when footing passes |
| A3 | **Warranty and incentive credit matcher** | Statement lines × open claims → pairs with confidence; exact OEM claim # first, then serial + amount, then fuzzy | Propose | Auto-settle only when claim # matches exactly, amount = claimed, confidence ≥ tenant threshold (default 95%) — never for short-pays or rejections |
| A4 | **DMS deal recap reader** | Deal recap / buyer's order PDF or DMS deal export → draft `dealer_unit_sales` + `trade_ins` (price, trade allowance, ACV, lien, rebates, deposit) | Propose | — (trade ACV always needs human approval) |
| A5 | **Unit cost classifier** | AP bill from a manufacturer or carrier → which unit(s) and cost type; flags a bill that is really a floored unit (prevents DL-13) | Propose | Auto-assign freight when the bill names one serial |
| A6 | **Program reader** | Manufacturer program bulletin → `oem_programs` DRAFT (type, treatment, dates, amounts, deadline) | Propose; always approval | — |
| A7 | **Explain / narrate** | "Why is this unit flagged?", lender-call prep: SOT list with sale evidence, payoff amounts and dates | Read-only | — |

Rule: the AI never changes a note balance, a claim status to PAID or WRITTEN_OFF, or a trade ACV on its own.

## 6. Controls and exception detectors

Detectors follow the `apps/web/src/lib/controls/*` pattern (pure scoring function + tests; writes a PROPOSED row to
`ai_decisions` with a stable feature code and pair/subject key so re-runs don't duplicate; `/exceptions` already folds
them in). Run nightly via the scheduler and on every relevant event.

| Code | Detector | Fires when | Severity | Surfaces |
|---|---|---|---|---|
| DL-1 | **Sold out of trust** | A note is SOLD_UNPAID past `payoff_due_date + sot_grace_days`; **or** a unit has a DMS deal or manufacturer warranty registration but no Books sale (the lender's own test [E]) | CRITICAL | `/exceptions`, Dealer home top tile, notification to bookkeeper + controller + owner, close blocker |
| DL-2 | Curtailment due / missed | Due within 7 days (warn) / unpaid after due date (missed) | MEDIUM / HIGH | `/exceptions`, Floor-plan page, home tile |
| DL-3 | Floor plan ↔ inventory ↔ GL mismatch | In-stock floored unit without an open note, open note on a unit not in stock, or subledger total ≠ GL by role (tolerance 0) | HIGH | `/exceptions`, close checklist |
| DL-4 | Aged unit | Days in stock passes each aging bucket; within `term_warning_days` of program max term (first client's lender: about 2 years [E]) | MEDIUM; HIGH within term window | Units page, home tile |
| DL-5 | Warranty claim aging / deadline | DRAFT within 5 days of filing deadline; SUBMITTED unpaid > 45 days (setting) | HIGH / MEDIUM | Warranty page, `/exceptions` |
| DL-6 | Warranty short-pay / rejection / rate | Credit < claimed; rejection rate for an OEM over 10% in 90 days | MEDIUM | Warranty page |
| DL-7 | Incentive aging / unclaimed | Accrued and not submitted within 10 days of program deadline; submitted unpaid > 60 days | MEDIUM | Incentives page |
| DL-8 | Lender statement variance | Any MATCH line with variance > `statement_tolerance_cents`, or LENDER_ONLY / BOOKS_ONLY lines unresolved at month end | HIGH | Lender statements page, close checklist |
| DL-9 | Interest variance | Billed interest vs accrued differs beyond tolerance | MEDIUM | Floor-plan page |
| DL-10 | Line utilization / credit hold | Principal > 90% of limit; line status CREDIT_HOLD | MEDIUM / HIGH | Home tile |
| DL-11 | Trade-in risk | Over-allowance > 20% of the sale (setting); lien unpaid > 10 days | MEDIUM | Deal view |
| DL-12 | Demo / rental on floor plan | Unit marked DEMO or RENTAL with an open note and the program has no demo terms | LOW | Units page |
| DL-13 | Double-recorded flooring | An AP bill line carries the serial or lender invoice # of a floored unit | HIGH | AP intake (blocks approve), `/exceptions` |

Close integration: the month-end close checklist gains items "Lender reconciliation signed for every active line",
"Dealer subledgers tie to GL (DL-3 clear)", "No open DL-1".

## 7. Reports and widgets

All reports: period selector, client scope, drill to unit / note / claim → source document → JE, CSV/XLSX export,
loading / empty / error states.

| # | Report | Content |
|---|---|---|
| R1 | **Floor-plan position** | By lender → line → program: principal, accrued interest, curtailments due next 30 days, SOT count and amount, utilization vs limit, days to maturity |
| R2 | **Floor-plan interest (carrying cost)** | By month, unit, department, manufacturer; interest per unit sold; free-floor days used |
| R3 | **Unit aging** | In-stock units by condition / make / model, days in stock buckets, cost, floored vs owned, days to term end, demo/rental flags |
| R4 | **Unit gross (deal profitability)** | Per sale: price − unit cost − over-allowance + cost-reduction incentives = gross; by salesperson, make, department |
| R5 | **Warranty receivable aging and recovery** | By OEM and status; days outstanding; recovery % (settled ÷ claimed); rejection rate; effective warranty labor rate |
| R6 | **Incentive receivable aging** | By OEM and program; accrued vs claimed vs settled; deadlines |
| R7 | **Departmental P&L** | WG new, WG used, parts, service, rental, admin columns + total; **service absorption** (parts + service gross profit ÷ dealership fixed expenses, a standard dealer KPI — a ratio only, not an allocation) |
| R8 | **Lender reconciliation** | Signed statement vs books, variance list with resolutions, audit history (each audit's SAU findings and how fast they were cleared) |
| R9 | **Borrowing base interaction** | Feeds `lib/borrowing-base/calc.ts` with **unencumbered** inventory: whole goods not on a floor-plan note + parts not on an open-account note. Floored units are the floor-plan lender's collateral and are excluded from the bank's base (new parameter `excludeFloorPlannedInventory`, default true — report to lead) |

**Dealer home widgets:** Sold not paid off (count, $, oldest days) · Curtailments due 14 days · Floor-plan utilization
by line · Units > 365 days · Warranty owed > 60 days · Incentives owed > 60 days · Last lender reconciliation date per
line.

## 8. Integrations and import

File first: every source gets a **mapping profile** (column → field, saved per client, reusable across clients on the
same system) on top of the existing `file_drop` connection method (07-INTEGRATIONS-PLAN). An import creates a
`dealer_import_batches` row, validates every row, shows accepted / rejected counts and proposes postings; nothing
posts until approved. APIs are added per vendor only once access is confirmed.

| System | Kind | What we need from it | Method v1 | API status | Priority |
|---|---|---|---|---|---|
| **c-Systems Infinity** | DMS (first client) | Units in stock (serial, model, cost, received date), unit sales / deals with trades, warranty claim register, internal setup repair orders | File export (Report Viewer / GL Interface file) | No public API found [R] | **P1** |
| Lightspeed EVO / Lightspeed DMS | DMS (powersports, marine, OPE) | Same | File | API to verify [U] | P2 |
| Ideal Computer Systems | DMS (OPE, ag) | Same | File | [U] | P3 |
| DIS (Dealer Information Systems) | DMS (ag, construction) | Same | File | [U] | P3 |
| Blackpurl | Cloud DMS (powersports, RV, marine) | Same | File, then API | Cloud product; API to verify [U] | P3 |
| VitalEdge (IntelliDealer, e-Emphasys) | DMS (ag, construction) | Same | File | [U] | P3 |
| ARI | Dealer websites / parts catalogs | Not accounting — out of scope | — | — | — |
| **Red Iron Acceptance / Huntington Distribution Finance** | Floor-plan lender (first client) | Statements, audit reports, payoff quotes, scheduled-payment lists | Email body / XLSX / PDF via A1 (forwarding address per client) | Dealer portal; API **[gap]** | **P1** |
| Wells Fargo Commercial Distribution Finance, Northpoint Commercial Finance, Truist / Sheffield, Synchrony, Kubota Credit, John Deere Financial | Floor-plan lenders | Same | Email / file via A1 | Portal exports [U] | P2 (per tenant demand) |
| Manufacturer dealer portals (warranty and statements) | OEM | Claim status, statement credits/debits, program bulletins | File / PDF via A2, A6 | Generally none public [U] | P1 for the first client's lines, P2 others |
| Plaid bank feed (existing) | Bank | Lender auto-debits (interest, payoffs, curtailments), manufacturer ACH credits | Existing feed; new match rules to `floor_plan_transactions` and claims | Live | P1 |
| AP inbox (existing) | Bills | Manufacturer and carrier invoices → unit costs (A5), DL-13 guard | Existing | Live | P1 |

**Opening import** (go-live) uses the same profiles: DMS stock list + lender statement + open warranty / incentive
lists, then the tie-out in §4.3.

## 9. Capabilities, navigation, switching the pack on

### 9.1 Capabilities (05-RBAC-SPEC §2.2 format, `books.` prefix omitted; registry `lib/rbac/capabilities.ts` is reserved spine — report to lead)

| Resource | Actions | Notes |
|---|---|---|
| `dealer.floor_plan` | V C E A P X K [M] | Lines, programs, notes, curtailments. A = approve proposed floor-plan postings; P = post; K = programs and terms. Payoff money leaves via existing `ap.payments` / payment-batch release (R stays there) |
| `dealer.units` | V C E D A X K | Register and cost build-up; D = void an unposted unit; A = approve write-downs, returns and rental moves (controller) |
| `dealer.warranty` | V C E A P X | A = accept short-pay / write-off / resubmit (parts & service manager) |
| `dealer.incentives` | V C E A P X K | K = programs |
| `dealer.trade_ins` | V C E A P | A = approve ACV / over-allowance (sales manager) |
| `dealer.lender_statements` | V C E A X | E = preparer; A = reviewer sign-off (preparer ≠ approver, DB CHECK) |
| `dealer.imports` | V C | Upload and map files |
| `dealer.settings` | V K [L] | Switch the pack on/off for a client, role map, department map, policies |

Default grants: bookkeeper V C E P on all + imports; controller adds A on all + settings K; owner V + A; parts &
service manager V + A on `dealer.warranty`; sales manager V + A on `dealer.trade_ins` and V on units.

### 9.2 Navigation

A **Dealer** group in the client workspace nav, rendered only when (a) `dealer_pack_settings.enabled` for the active
client and (b) the user holds V on at least one `dealer.*` resource. Items: Dealer home · Floor plan · Units ·
Lender statements · Warranty · Incentives · Trade-ins · Imports. Dealer reports (§7) appear under Reports only for
enabled clients. `navigation.ts` is reserved spine — the lead adds the entries.

### 9.3 Switching the pack on (per client)

1. Entry points: client Settings → **Industry packs** → Dealer; or onboarding, when the client's industry is
   `equipment_dealer` (the industry-packs catalog key), the wizard offers the pack.
2. Steps: choose DMS → map department roles → map account roles (§3.0; required roles block) → add lenders, lines,
   programs (AI can draft from a lender statement) → opening import + tie-out (§4.3) → controller enables
   (`dealer.settings:K`, step-up). Enabling writes an `audit_log` / `core.action_log` entry.
3. Turning it off hides the nav and stops detectors; data and postings remain (never deleted).
4. Whether the pack is a priced add-on (Suite-Core entitlement) is an owner decision (Q5); v1 gates by setting only.

## 10. Acceptance criteria and Completeness Ledger

### 10.1 Acceptance criteria (each is a test)

1. **Enable gate:** enabling a client fails while any required role or department role is unmapped or the opening
   tie-out differs by ≥ 1¢; succeeds when complete; nav shows Dealer only for that client.
2. **Flooring:** importing a lender flooring line for U-1 creates unit + note + FLOOR txn and, on approval, posts
   DR `WHOLE_GOODS_INVENTORY` 1,000,000 / CR `FLOOR_PLAN_PAYABLE` 1,000,000; re-importing the same file posts nothing.
3. **Interest:** 30 interest-bearing days on 1,000,000¢ at 900 bps accrues exactly 7,397¢; no interest during free-floor
   days; a 7,410¢ lender debit clears the accrual with a 13¢ true-up; a 5,000¢ difference raises DL-9 and doesn't post.
4. **Curtailment:** day-180 10% row exists on flooring; DL-2 fires 7 days before; payment reduces the note to 900,000¢
   and leaves unit cost at 1,040,000¢.
5. **Sale + payoff:** posting the §3.4 sale produces the exact lines shown, marks the note SOLD_UNPAID with payoff due
   on the sale date, proposes a 900,000¢ payoff; release requires a different user than the preparer.
6. **SOT:** with no payoff after grace days, DL-1 CRITICAL appears; a unit with a warranty registration date but no
   Books sale also raises DL-1; paying off clears it.
7. **Trade-in:** the §3.5 deal posts the five lines and balances at 1,470,000¢ under LOWER_OF_ACV_AND_ALLOWANCE; the
   used unit is created at 250,000¢; ACV approval by a user without `dealer.trade_ins:A` is refused.
8. **Setup cost:** an internal setup RO of 9,000¢ labor + 6,000¢ parts adds 15,000¢ to the unit; no overhead rate or
   burden is applied anywhere (reviewer check).
9. **Warranty:** the §3.8 claim posts 29,400¢ receivable split 19,000 / 10,400; a 27,000¢ OEM credit matched by A3
   leaves the claim PARTIAL until a parts & service manager accepts the 2,400¢ short-pay; claimed ≠ sum of
   components is rejected by the DB.
10. **Incentives:** a retail rebate posts to `OEM_INCENTIVE_RECEIVABLE` within the sale; a dealer rebate on an
    in-stock unit reduces that unit's cost; on a sold unit it credits `WHOLE_GOODS_COGS`.
11. **Lender reconciliation:** importing a statement whose lines don't foot to the footer is rejected; a footing
    statement matches by invoice # then serial; variance > tolerance raises DL-8; the preparer can't approve.
12. **Tie-out:** at month end `v_dealer_subledger_tieout` shows zero difference for floor-plan payable, whole-goods
    inventory, warranty and incentive receivables; any difference raises DL-3 and blocks the close checklist item.
13. **DL-13:** an AP bill with a floored serial can't be approved as a bill.
14. **Departments:** every posted pack line carries the mapped department; the departmental P&L foots to the client P&L.
15. **Isolation:** a user scoped to another client can't see or post this client's units, notes or claims
    (tenant-isolation + client-scope tests); every new table has RLS (schema guard test).
16. **AI:** every AI output has an `ai_decisions` row and a gateway usage row; with autonomy at default nothing posts
    without a human; A3 auto-settle only fires on exact claim # + exact amount + confidence ≥ threshold.
17. **States:** every pack screen renders loading, empty, populated and error states; keyboard accessible (chrome-auditor).
18. **Genericity:** no lender, manufacturer, DMS or client name appears in code paths or seeds except catalog
    entries and test fixtures (reviewer grep).

### 10.2 Completeness Ledger (all start at 0 — nothing built)

| Feature | Spec | Schema | Engine + tests | Routes | UI | Detectors | Verified |
|---|---|---|---|---|---|---|---|
| V1 Lines / programs / notes | ✅ this FPB | — | — | — | — | — | — |
| V2 Flooring / interest / curtailment / payoff | ✅ | — | — | — | — | — | — |
| V3 SOT detection | ✅ | — | — | — | — | — | — |
| V4 Unit register + cost build-up | ✅ (Q1 pending) | — | — | — | — | — | — |
| V5 Lender statement / audit rec | ✅ | — | — | — | — | — | — |
| V6 Warranty receivable | ✅ | — | — | — | — | — | — |
| V7 Incentives receivable | ✅ | — | — | — | — | — | — |
| V8 Trade-ins | ✅ | — | — | — | — | — | — |
| V9 Departmental tagging + P&L | ✅ | — | — | — | — | — | — |
| V10 Imports (c-Systems, lender, OEM) | ✅ | — | — | — | — | — | — |
| V11 Reports, widgets, borrowing base | ✅ | — | — | — | — | — | — |

### 10.3 Build sequence

1. Lead: owner rulings Q1/Q5; apply `169_dealer_pack` (Appendix A) to Supabase first; add capabilities, nav, entry
   types, role keys (reserved spine).
2. Pure engines + tests (no I/O): interest, curtailment schedule, payoff/SOT state machine, trade-in valuation, warranty
   and incentive accrual/settlement, statement matcher, tie-out.
3. Imports + mapping profiles (c-Systems first, lender email/XLSX), A1/A2 parsers.
4. Routes (`apiHandler`, require-permission) + posting through `postJournalEntry`.
5. Detectors DL-1…DL-13 into `ai_decisions`; close checklist items.
6. UI (designer) → verifier, chrome-auditor, security (money + client scope), reviewer → scribe.

## 11. Questions for the owner

1. **Unit list in Books.** Our plan saves "tracking items by serial number" for a future Inventory product. The
   dealer pack needs a list of each machine (serial, cost, which loan it's on) to track the floor-plan debt. OK to
   build that list in Books now, with the dealer system still the master for stock counts?
2. **Where are the first client's books today?** Our notes say Sage Intacct (cancelled 10/1/2026), but the August
   balance sheet looks like QuickBooks Online. Which is the real book of record, and did anyone save the Intacct data?
3. **Other lenders and brands.** Besides Red Iron, does the store floor-plan with any other lender, and which
   manufacturer brands does it carry? Who at the store files warranty claims and rebates today, and do the credits
   come as statement credits or checks?
4. **Getting the data.** Can someone at the store export from c-Systems (machines in stock with serial and cost, sales,
   warranty claims), and can the lender's statements and audit reports be emailed to an address MeritBooks reads?
5. **Price.** Is the dealer pack a paid add-on for future dealer customers, or included in Books?

## Appendix A — SQL sketch: 169_dealer_pack (proposed)

Sketch for the lead — **not applied**. Column lists abbreviated where §4.3 is explicit; the builder writes the full
migration, applies it to Supabase first, then runs the guard tests (schema, schema-contract, tenant-isolation,
client-scope coverage).

```sql
-- =============================================================================
-- Migration 169: dealer pack (FPB-dealer-pack.md) — ADDITIVE + IDEMPOTENT
-- Books-owned public tables; every table: org_id + owning-client location_id + RLS.
-- Client-scope RLS (mig 163) attaches via core.apply_client_scope_rls() at the end.
-- =============================================================================

-- 1. Account roles (no default numbers: mapped per client at enable time)
insert into core.account_role_keys (role_key, label, scope, default_account_number) values
  ('WHOLE_GOODS_INVENTORY',       'Whole goods inventory (new units)',          'LOCATION', null),
  ('USED_WHOLE_GOODS_INVENTORY',  'Used whole goods inventory',                 'LOCATION', null),
  ('RENTAL_INVENTORY',            'Rental-ready units at cost',                 'LOCATION', null),
  ('FLOOR_PLAN_PAYABLE',          'Floor plan payable',                         'LOCATION', null),
  ('FLOOR_PLAN_INTEREST_ACCRUED', 'Accrued floor plan interest',                'LOCATION', null),
  ('FLOOR_PLAN_INTEREST',         'Floor plan interest expense',                'ORG',      null),
  ('FLOOR_PLAN_FEES',             'Floor plan fees (late, audit)',              'ORG',      null),
  ('WHOLE_GOODS_SALES',           'Whole goods sales (new)',                    'ORG',      null),
  ('WHOLE_GOODS_COGS',            'Whole goods cost of sales (new)',            'ORG',      null),
  ('USED_GOODS_SALES',            'Used whole goods sales',                     'ORG',      null),
  ('USED_GOODS_COGS',             'Used whole goods cost of sales',             'ORG',      null),
  ('TRADE_IN_OVER_ALLOWANCE',     'Trade-in over-allowance (contra revenue)',   'ORG',      null),
  ('TRADE_LIEN_PAYOFF',           'Trade-in lien payoff payable',               'LOCATION', null),
  ('SETUP_LABOR_CAPITALIZED',     'Setup/PDI labor capitalized to units',       'ORG',      null),
  ('INVENTORY_WRITEDOWN',         'Unit inventory write-down (NRV)',            'ORG',      null),
  ('WARRANTY_RECEIVABLE',         'Manufacturer warranty claims receivable',    'LOCATION', null),
  ('WARRANTY_LABOR_SALES',        'Warranty labor sales',                       'ORG',      null),
  ('WARRANTY_PARTS_SALES',        'Warranty parts sales',                       'ORG',      null),
  ('WARRANTY_POLICY_EXPENSE',     'Warranty short-pay / rejection / policy',    'ORG',      null),
  ('OEM_INCENTIVE_RECEIVABLE',    'Manufacturer incentives receivable',         'LOCATION', null),
  ('CO_OP_ADVERTISING_RECOVERY',  'Co-op advertising recovery (contra OPEX)',   'ORG',      null)
on conflict (role_key) do update set label = excluded.label, scope = excluded.scope;

-- 2. Entry types (mig 055 pattern)
alter type public.entry_type_enum add value if not exists 'FLOOR_PLAN';
alter type public.entry_type_enum add value if not exists 'FLOOR_PLAN_INTEREST';
alter type public.entry_type_enum add value if not exists 'UNIT_SALE';
alter type public.entry_type_enum add value if not exists 'TRADE_IN';
alter type public.entry_type_enum add value if not exists 'WARRANTY_CLAIM';
alter type public.entry_type_enum add value if not exists 'OEM_INCENTIVE';
alter type public.entry_type_enum add value if not exists 'UNIT_COST';

-- 3. Settings + department map
create table if not exists public.dealer_pack_settings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  enabled boolean not null default false,
  enabled_at timestamptz, enabled_by text,
  dms_system text,
  trade_valuation_policy text not null default 'LOWER_OF_ACV_AND_ALLOWANCE'
    check (trade_valuation_policy in ('LOWER_OF_ACV_AND_ALLOWANCE','ACV','ALLOWANCE')),
  warranty_recognition text not null default 'ON_SUBMIT' check (warranty_recognition in ('ON_RO_CLOSE','ON_SUBMIT')),
  sot_grace_days int not null default 2 check (sot_grace_days between 0 and 30),
  aging_buckets int[] not null default '{90,180,270,365}',
  term_warning_days int not null default 60,
  interest_tolerance_cents bigint not null default 2500,
  statement_tolerance_cents bigint not null default 100,
  auto_match_min_confidence_bps int not null default 9500 check (auto_match_min_confidence_bps between 0 and 10000),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (org_id, location_id)
);

create table if not exists public.dealer_department_map (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  dept_role text not null check (dept_role in ('WG_NEW','WG_USED','PARTS','SERVICE','RENTAL','ADMIN')),
  department_id uuid not null references core.departments(id),
  unique (org_id, location_id, dept_role)
);

-- 4. Floor plan
create table if not exists public.floor_plan_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  lender_vendor_id uuid not null references core.vendors(id),
  name text not null,
  credit_limit_cents bigint not null default 0 check (credit_limit_cents >= 0),
  liability_account_id uuid references public.accounts(id),
  interest_due_day int check (interest_due_day between 1 and 31),
  scheduled_payment_day int check (scheduled_payment_day between 1 and 31),
  debt_instrument_id uuid references public.debt_instruments(id),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','SUSPENDED','CREDIT_HOLD','CLOSED')),
  created_at timestamptz not null default now()
);

create table if not exists public.floor_plan_programs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  line_id uuid not null references public.floor_plan_lines(id),
  oem_vendor_id uuid references core.vendors(id),
  name text not null,
  free_floor_days int not null default 0 check (free_floor_days >= 0),
  rate_type text not null default 'FIXED' check (rate_type in ('FIXED','INDEX_PLUS')),
  rate_bps int not null default 0 check (rate_bps >= 0),
  index_name text, spread_bps int,
  sau_penalty_rate_bps int,
  payoff_terms text not null default 'PAY_AS_SOLD' check (payoff_terms in ('PAY_AS_SOLD','DAYS_AFTER_SALE')),
  payoff_days int not null default 0 check (payoff_days >= 0),
  max_term_days int check (max_term_days > 0),
  curtailment_schedule jsonb not null default '[]',
  effective_from date not null default current_date, effective_to date
);

create table if not exists public.dealer_units (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  serial_number text not null, vin_hin text, stock_number text,
  make_vendor_id uuid references core.vendors(id),
  model text, model_year int, item_id uuid references core.items(id),
  condition text not null check (condition in ('NEW','USED','DEMO','RENTAL')),
  is_consignment boolean not null default false,
  status text not null default 'IN_STOCK' check (status in
    ('ON_ORDER','IN_TRANSIT','IN_STOCK','SOLD','DELIVERED','RENTAL','RETURNED','WRITTEN_OFF','VOID')),
  received_date date, sold_date date, warranty_registered_date date,
  cost_cents bigint not null default 0,
  source text not null default 'MANUAL' check (source in ('DMS','LENDER','MANUAL','TRADE_IN')),
  external_ref text, import_batch_id uuid,
  created_at timestamptz not null default now(),
  check (status not in ('SOLD','DELIVERED') or sold_date is not null)
);
create unique index if not exists ux_dealer_units_serial
  on public.dealer_units (org_id, location_id, coalesce(make_vendor_id, '00000000-0000-0000-0000-000000000000'::uuid), serial_number)
  where status <> 'VOID';

create table if not exists public.dealer_unit_costs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  unit_id uuid not null references public.dealer_units(id),
  cost_type text not null check (cost_type in
    ('BASE_INVOICE','FREIGHT','SETUP_PDI','ACCESSORY','RECON','OTHER','REBATE_REDUCTION','WRITE_DOWN')),
  amount_cents bigint not null,
  source_type text not null check (source_type in ('FLOOR_PLAN_NOTE','BILL_LINE','INTERNAL_RO','INCENTIVE','JE','TRADE_IN')),
  source_id uuid,
  status text not null default 'PROPOSED' check (status in ('PROPOSED','POSTED','VOID')),
  gl_entry_id uuid references public.gl_entries(id),
  idempotency_key text not null unique,
  check ((cost_type in ('REBATE_REDUCTION','WRITE_DOWN') and amount_cents < 0)
      or (cost_type not in ('REBATE_REDUCTION','WRITE_DOWN') and amount_cents > 0))
);

create table if not exists public.floor_plan_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  line_id uuid not null references public.floor_plan_lines(id),
  program_id uuid references public.floor_plan_programs(id),
  unit_id uuid references public.dealer_units(id),
  collateral_type text not null default 'WHOLE_GOOD' check (collateral_type in ('WHOLE_GOOD','OPEN_ACCOUNT','OTHER')),
  lender_invoice_number text not null,
  floored_date date not null,
  original_principal_cents bigint not null check (original_principal_cents > 0),
  principal_balance_cents bigint not null,
  free_floor_end_date date, maturity_date date, scheduled_due_date date,
  status text not null default 'OPEN' check (status in ('OPEN','SOLD_UNPAID','PAID_OFF','IN_DEFAULT','RETURNED','VOID')),
  payoff_due_date date,
  sold_detected_by text check (sold_detected_by in ('BOOKS_SALE','DMS_DEAL','WARRANTY_REG','LENDER_AUDIT')),
  check (principal_balance_cents between 0 and original_principal_cents),
  check (collateral_type <> 'WHOLE_GOOD' or unit_id is not null),
  unique (line_id, lender_invoice_number, unit_id)
);

create table if not exists public.floor_plan_transactions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  note_id uuid not null references public.floor_plan_notes(id),
  txn_type text not null check (txn_type in ('FLOOR','CURTAILMENT','PAYOFF','INTEREST_ACCRUAL',
    'INTEREST_BILLED','INTEREST_PAID','FEE','ADJUSTMENT','REVERSAL')),
  txn_date date not null,
  principal_cents bigint not null default 0, interest_cents bigint not null default 0, fee_cents bigint not null default 0,
  status text not null default 'PROPOSED' check (status in ('PROPOSED','POSTED','VOID')),
  gl_entry_id uuid references public.gl_entries(id),
  bank_transaction_id uuid, payment_id uuid,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.floor_plan_curtailments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  note_id uuid not null references public.floor_plan_notes(id),
  due_date date not null, amount_cents bigint not null check (amount_cents > 0),
  status text not null default 'DUE' check (status in ('DUE','PAID','WAIVED','MISSED')),
  paid_txn_id uuid references public.floor_plan_transactions(id)
);

-- 5. Lender statements / audits
create table if not exists public.lender_statements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  line_id uuid not null references public.floor_plan_lines(id),
  kind text not null check (kind in ('STATEMENT','AUDIT','PAYOFF_QUOTE')),
  statement_date date not null, document_id uuid,
  footer_principal_cents bigint, footer_interest_cents bigint, footer_fees_cents bigint,
  status text not null default 'IMPORTED' check (status in ('IMPORTED','MATCHING','PREPARED','APPROVED')),
  prepared_by text, approved_by text,
  check (approved_by is null or approved_by <> prepared_by)
);
create table if not exists public.lender_statement_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  statement_id uuid not null references public.lender_statements(id) on delete cascade,
  lender_invoice_number text, serial_number text, model text,
  original_cents bigint, current_cents bigint, interest_cents bigint,
  lender_code text, disposition_date date, days int,
  matched_note_id uuid references public.floor_plan_notes(id),
  match_status text not null default 'UNMATCHED'
    check (match_status in ('UNMATCHED','MATCHED','VARIANCE','LENDER_ONLY','BOOKS_ONLY','RESOLVED')),
  variance_cents bigint not null default 0, resolution text
);

-- 6. Sales and trade-ins
create table if not exists public.trade_ins (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  customer_id uuid references core.customers(id),
  used_unit_id uuid references public.dealer_units(id),
  allowance_cents bigint not null check (allowance_cents >= 0),
  acv_cents bigint not null check (acv_cents >= 0),
  recorded_value_cents bigint not null check (recorded_value_cents >= 0),
  over_allowance_cents bigint generated always as (greatest(allowance_cents - recorded_value_cents, 0)) stored,
  lien_payoff_cents bigint not null default 0 check (lien_payoff_cents >= 0),
  lienholder_vendor_id uuid references core.vendors(id),
  lien_paid_txn_id uuid,
  appraised_by text, approved_by text,
  status text not null default 'DRAFT' check (status in ('DRAFT','APPROVED','POSTED','VOID'))
);
create table if not exists public.dealer_unit_sales (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  unit_id uuid not null references public.dealer_units(id),
  invoice_id uuid references public.invoices(id),
  customer_id uuid references core.customers(id),
  sale_date date not null,
  sale_price_cents bigint not null check (sale_price_cents >= 0),
  deposit_applied_cents bigint not null default 0,
  retail_rebate_cents bigint not null default 0,
  trade_in_id uuid references public.trade_ins(id),
  source text not null default 'BOOKS' check (source in ('BOOKS','DMS')),
  external_deal_ref text,
  status text not null default 'PROPOSED' check (status in ('PROPOSED','POSTED','VOID')),
  gl_entry_id uuid references public.gl_entries(id)
);
create unique index if not exists ux_unit_sale_one_live on public.dealer_unit_sales(unit_id) where status <> 'VOID';

-- 7. Warranty + incentives + OEM statements
create table if not exists public.warranty_claims (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  oem_vendor_id uuid not null references core.vendors(id),
  oem_claim_number text, dealer_claim_ref text, repair_order_ref text,
  job_id uuid references core.jobs(id), unit_id uuid references public.dealer_units(id), serial_number text,
  customer_id uuid references core.customers(id),
  failure_date date, repair_date date, submitted_date date, filing_deadline date,
  labor_hours numeric(8,2) not null default 0, labor_rate_cents bigint not null default 0,
  labor_cents bigint not null default 0, parts_cost_cents bigint not null default 0,
  parts_markup_bps int not null default 0, parts_cents bigint not null default 0,
  sublet_cents bigint not null default 0, freight_cents bigint not null default 0, other_cents bigint not null default 0,
  claimed_cents bigint not null, approved_cents bigint, settled_cents bigint not null default 0,
  status text not null default 'DRAFT' check (status in
    ('DRAFT','SUBMITTED','PARTIAL','PAID','REJECTED','RESUBMITTED','WRITTEN_OFF','DEBITED')),
  rejection_reason text, gl_entry_id uuid references public.gl_entries(id),
  check (claimed_cents = labor_cents + parts_cents + sublet_cents + freight_cents + other_cents),
  check (claimed_cents >= 0)
);

create table if not exists public.oem_programs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  oem_vendor_id uuid not null references core.vendors(id),
  program_code text, name text not null,
  program_type text not null check (program_type in ('RETAIL_REBATE','DEALER_REBATE','VOLUME_BONUS','HOLDBACK',
    'CO_OP','SPIFF','INTEREST_SUBSIDY','FLOOR_PLAN_SUPPORT','DEMO_SUPPORT','OTHER')),
  treatment text not null check (treatment in ('TRANSACTION_PRICE','COST_REDUCTION','EXPENSE_REIMBURSEMENT','PASS_THROUGH')),
  start_date date, end_date date, claim_deadline_days int, rules jsonb not null default '{}',
  source_document_id uuid,
  status text not null default 'DRAFT' check (status in ('DRAFT','ACTIVE','EXPIRED'))
);
create table if not exists public.oem_incentive_claims (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  program_id uuid not null references public.oem_programs(id),
  unit_id uuid references public.dealer_units(id), sale_id uuid references public.dealer_unit_sales(id),
  earned_date date not null, claim_deadline date,
  accrued_cents bigint not null check (accrued_cents >= 0),
  claimed_cents bigint not null default 0, settled_cents bigint not null default 0,
  status text not null default 'ACCRUED' check (status in ('ACCRUED','SUBMITTED','PARTIAL','PAID','REJECTED','WRITTEN_OFF')),
  gl_entry_id uuid references public.gl_entries(id),
  check (settled_cents <= greatest(claimed_cents, accrued_cents))
);
create table if not exists public.oem_statements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  oem_vendor_id uuid not null references core.vendors(id),
  statement_date date not null, document_id uuid, footer_total_cents bigint,
  status text not null default 'IMPORTED' check (status in ('IMPORTED','MATCHING','SETTLED'))
);
create table if not exists public.oem_statement_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  statement_id uuid not null references public.oem_statements(id) on delete cascade,
  line_type text not null check (line_type in ('WARRANTY_CREDIT','INCENTIVE_CREDIT','DEBIT','PARTS_INVOICE','OTHER')),
  reference text, serial_number text, amount_cents bigint not null,
  matched_warranty_claim_id uuid references public.warranty_claims(id),
  matched_incentive_claim_id uuid references public.oem_incentive_claims(id),
  match_status text not null default 'UNMATCHED' check (match_status in ('UNMATCHED','PROPOSED','MATCHED','SETTLED','IGNORED')),
  ai_decision_id uuid, settlement_gl_entry_id uuid references public.gl_entries(id),
  check (num_nonnulls(matched_warranty_claim_id, matched_incentive_claim_id) <= 1)
);

create table if not exists public.dealer_import_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.get_org_id() references core.organizations(id) on delete cascade,
  location_id uuid not null references core.locations(id),
  source_system text not null,
  file_kind text not null check (file_kind in ('UNITS','DEALS','WARRANTY','LENDER_STATEMENT','LENDER_AUDIT',
    'OEM_STATEMENT','PROGRAMS','OPENING')),
  document_id uuid, row_count int, accepted_count int, rejected_count int, errors jsonb not null default '[]',
  status text not null default 'UPLOADED' check (status in ('UPLOADED','VALIDATED','PROPOSED','POSTED','UNDONE','FAILED')),
  created_by text, created_at timestamptz not null default now()
);

-- 8. RLS: house pattern on every new table, then client scope (mig 163)
do $$ declare t text; begin
  foreach t in array array['dealer_pack_settings','dealer_department_map','floor_plan_lines','floor_plan_programs',
    'dealer_units','dealer_unit_costs','floor_plan_notes','floor_plan_transactions','floor_plan_curtailments',
    'lender_statements','lender_statement_lines','trade_ins','dealer_unit_sales','warranty_claims','oem_programs',
    'oem_incentive_claims','oem_statements','oem_statement_lines','dealer_import_batches'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname='org_isolation') then
      execute format('create policy "org_isolation" on public.%I for all using (org_id = public.get_org_id()) with check (org_id = public.get_org_id())', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname='service_write') then
      execute format('create policy "service_write" on public.%I for all to service_role using (true) with check (true)', t);
    end if;
    execute format('grant select, insert, update, delete on public.%I to authenticated, service_role', t);
  end loop;
end $$;
-- Posted floor-plan / cost / claim rows are immutable except via reversal (mirror mig 153 trigger pattern).
select core.apply_client_scope_rls();
```

Lead notes: (1) confirm `public.invoices`, `core.jobs`, `core.departments`, `public.debt_instruments` FK targets
against the live schema before applying (Rule 11); (2) no `anon` grants (mig 154/167 posture); (3) views from §4.3
use `security_invoker = true` (mig 066); (4) capability keys, nav entries and the borrowing-base parameter are
reserved-spine changes for the lead.

## Appendix B — Sources

**Repo [R]:** `CLAUDE.md`; `docs/canon/CANON-ANCHOR.md` §1–3; `docs/canon/10-suite-contracts-digest.md` (core.items —
serialization reserved for MeritInventory); `docs/FPB-commissions.md` (format); `docs/ia/IA-SPEC.md` §1.1 glossary;
`docs/ia/05-RBAC-SPEC.md` §2.2; `docs/ia/07-INTEGRATIONS-PLAN.md` (c-Systems Infinity, Sage Intacct cancellation,
file-drop lane); `docs/ia/09-COMPETITIVE-FEATURE-MATRIX.md` §3 items 17 and 20; migrations 029 (account role keys),
064, 066, 083 (debt instruments), 101 (inventory + role pattern), 140 (customer deposits), 149 (role keys), 153, 157
(capability registry), 162 (scheduler), 163 (client-scope RLS, `core.apply_client_scope_rls()`);
`apps/web/src/lib/controls/*` (detector pattern), `apps/web/src/lib/borrowing-base/calc.ts`,
`packages/core-ai/src/gateway.ts` (`runAiGateway`), `packages/industry-packs/src/packs/equipment_dealer.ts`
(vocabulary: warranty repair job type, `oem_claim_number`, `claim_deadline`, pay types customer/warranty/internal,
`warranty_writeoff` approval, warranty labor rate setting).

**Owner's mailbox [E]:** thread "Clive Power Equipment Audit Follow-up & Payment Reminder" from the floor-plan lender,
May 7 – Sep 24, 2026 (pay-as-sold terms, interest due 15th, scheduled/open-account payments due ~25th, audit
resolution window, 21.9% sold-and-unpaid rate, ~2-year term, late fees, credit hold, audit SAU lists with serial and
model, warranty-registration dating of SOT).

**Owner's Dropbox [D]:** `/Merit Management/2026/Balance Sheet/August/Clive Power Equipment_Balance Sheet (1).xlsx`
(as of Aug 31, 2026; QuickBooks Online layout; account structure only used here).

**Web [W]:** The Toro Company / TCF Inventory Finance joint-venture release forming Red Iron Acceptance (floor plan and
open-account financing for Toro and Exmark dealers):
[thetorocompany.com](https://www.thetorocompany.com/news-releases/news-release-details/toro-company-and-tcf-inventory-finance-form-joint-venture),
[SEC exhibit](https://www.sec.gov/Archives/edgar/data/814184/000110465909050334/a09-23354_1ex99d1.htm);
floor-plan bookkeeping practice (flooring, interest accrual, curtailments as principal reduction, payoff on sale;
vendor guidance, not authoritative):
[beancount.io dealer floorplan guide](https://beancount.io/blog/2026/05/26/independent-used-car-dealer-bookkeeping-floorplan-financing-curtailment-fi-reserve-holdback-chargeback-recon-wip-form-8300-ftc-used-car-rule-bhph-repossession-loss-reserve-guide).

**Unverified [U]:** ASC 606 / ASC 705-20 / ASC 330 treatments named in §3.7–3.9, warranty credits arriving as OEM
statement credits, DMS API availability (Lightspeed, Ideal, DIS, Blackpurl, VitalEdge), other lenders' portal exports.
The controller (or the client's CPA) confirms treatments before build; builders verify vendor APIs before promising them.
