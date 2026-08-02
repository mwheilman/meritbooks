# Segment Deep-Dive — Tax & Compliance

**Authors:** a Tax/compliance leader (CPA, 25+ yrs, multistate SALT + income + assurance-adjacent)
paired with a senior AI engineer.
**Posture:** analysis / spec only. This document plans; it does not build. Every capability below
inherits the canon posture verbatim — *AI proposes FACTS; the deterministic engine does the
accounting; a human approves; every AI action → Decision Log* (`docs/canon/CANON-ANCHOR.md` §3).
**Non-negotiable liability line:** MeritBooks (and Merit) is **never the regulated party**. It does
not sign returns, register the taxpayer, remit tax, or e-file as agent of record. Where a filing,
a TIN match, a rate lookup, or a signature crosses a licensed/regulated boundary, a **licensed
provider** does the regulated act; MeritBooks assembles the audit-defensible evidence and hands off.

**Ground read:** `docs/canon/CANON-ANCHOR.md`; `docs/discovery/books/cpa-tax-assurance.md` (the CPA
brief this segment operationalizes); `docs/discovery/books/AI-CAPABILITY-CATALOG.md` §F;
`docs/FPB-financial-control-exceptions.md` (EC-7/8/9/10/12). This segment is the **tax/compliance
projection** of those documents plus a marked build-state census of the live repo.

---

## PART 1 — HOW TAX & COMPLIANCE ACTUALLY RUNS (operational reality + where money leaks)

Engineers keep modeling "tax" as a report you generate in April. It is not. It is a **year-long
evidence-gathering discipline** whose byproduct is a filing. The value is in the 11 continuous
motions below; the return is the last, cheapest step once the ledger carried the facts all year.
A recurring truth from the CPA brief: **~90% of year-end tax work is reconstructing facts the
bookkeeping system failed to capture.** Each reconstruction is a leak an owned ledger closes at the
source.

### 1.1 Sales & use tax / nexus (the highest-$, most-silent leak)

- **The motion:** determine where the entity has **nexus** (physical: office, employee, inventory in
  a 3PL/FBA warehouse; or **economic** post-*Wayfair* 2018: commonly **$100k sales OR 200
  transactions** per state per rolling 12 months, but the threshold and the "OR/AND" vary by state and
  keep changing) → **register** with each state's DOR → determine **taxability** of each product/
  service in each state (SaaS taxable in some, exempt in others; services vary wildly; shipping
  sometimes taxable) → apply the **right rate** at the right ship-to jurisdiction (state + county +
  city + special district — ~13,000 US jurisdictions) → **collect** it on invoices → **file & remit**
  on each state's cadence (monthly/quarterly/annual, each with its own form and portal) → keep
  **exemption certificates** for exempt sales → **self-assess use tax** on taxable purchases where no
  sales tax was charged.
- **Leak points:**
  - **Uncollected tax where nexus exists** — the seller **eats it out of pocket** (can't retro-bill
    customers), plus penalty + interest. A multistate SMB can carry a **six-figure undisclosed
    liability** that only surfaces in due diligence and re-prices or kills a deal. *This is the single
    highest-dollar catch in the whole segment.*
  - **Use tax never self-assessed** on out-of-state/online purchases — a near-universal SMB miss; the
    first thing a state auditor tests because it is easy money.
  - **Wrong taxability / wrong rate** — under-collect (seller eats it) or over-collect (customer
    refunds, class-action risk, DOR liability for collected-but-unremitted tax).
  - **Missing/expired exemption certificates** — an exempt sale with no valid cert on file becomes a
    **taxable** sale on audit; the seller owes the tax it never collected.
  - **Nexus ≠ only sales tax** — payroll in a state, inventory in a state, or a remote employee also
    creates **income-tax and franchise-tax** nexus and filing obligations that get missed entirely.

### 1.2 Information returns — 1099-NEC/MISC, W-9, TIN (the January fire drill)

- **The motion:** collect a **W-9 BEFORE the first payment** → determine **reportable vendors**
  (unincorporated payees — individuals, LLCs, partnerships — paid **≥ $600** for services in the
  calendar year by a **reportable rail**: cash/check/ACH/wire) → **exclude** card / third-party-
  network payments (those are on the processor's **1099-K**; issuing a 1099-NEC on top **double-
  reports**) → **TIN-match** each name+TIN against the IRS database → **file by Jan 31** to IRS +
  payee + often the state.
- **Leak points:**
  - **W-9 never collected up front** → a frantic January chase of vendors paid all year, some now
    unreachable → late/incorrect filings.
  - **TIN mismatch** → IRS **CP2100 notice → 24% backup withholding** the payer becomes liable for →
    **B-notice** penalty cycle (**$60–$310 per form**, annual cap in the low millions).
  - **Double-reporting** card-paid amounts already on a 1099-K.
  - **Backup withholding never accrued** when a valid W-9 is absent — a direct payer liability.

### 1.3 Income tax provision (ASC 740) + book-to-tax (M-1/M-3)

- **The motion:** **book income ≠ taxable income.** Build the bridge (Schedule **M-1/M-3**): meals
  (50% deductible), entertainment (0%), penalties/fines (0%), federal tax, tax-exempt interest,
  **§179/bonus vs. book depreciation**, bad-debt reserve vs. actual write-off (§166), accrual-to-cash
  items, prepaids, §174 R&D capitalization, life insurance, etc. For any entity with an audit/review/
  investors/lenders, the same differences must be **classified temporary vs. permanent** to compute
  the **tax provision** (current + deferred tax expense, DTA/DTL, valuation allowance, FIN 48
  uncertain positions, rate reconciliation).
- **Leak points:**
  - **Year-end reconstruction** of which items are non-deductible or timing-different — book NI moves
    **5–25%** between the client's handoff book and the CPA's adjusted book.
  - **Deferred tax is the #1 private-company restatement source** — almost always a spreadsheet of
    temporary differences that **drifted from the GL**.
  - **Estimated payments / safe harbor missed** (100/110% prior-year) → underpayment penalties.

### 1.4 Fixed assets — capex vs. expense, depreciation, §179/bonus elections

- **The motion:** decide **capitalize vs. expense** (de-minimis safe harbor $2,500/$5,000; repair-vs-
  improvement / RABI test) → set **book** depreciation (straight-line, posted to the GL) → run a
  **parallel tax** schedule (MACRS / **§179** immediate expense / **bonus**) → make the **annual,
  often-irrevocable elections** → track **dispositions** (sale/scrap) and **depreciation recapture**.
- **Leak points:** expensing a capital asset (overstates current deductions, reverses on exam);
  capitalizing a repair (defers a deduction owed); **missed §179/bonus/de-minimis elections** (annual,
  frequently irrevocable — permanently lost money); **assets sold but still depreciating** (permanent
  overstatement of deductions and assets); book-vs-tax depreciation timing difference never tracked →
  wrong deferred tax.

### 1.5 Apportionment & multistate income/franchise filings

- **The motion:** for each state with income-tax nexus, compute the **apportionment factor** (single-
  sales-factor in most states now; a few still 3-factor sales/payroll/property), file the state
  return, and decide **PTET (pass-through entity tax)** / composite elections — a live cash decision
  most SMBs miss (PTET converts a non-deductible SALT cap item into a deductible entity tax).
- **Leak points:** filing in the wrong states or none; wrong sourcing of receipts; PTET election
  deadline missed (a hard-dollar tax saving forgone).

### 1.6 Related-party / intercompany / transfer pricing (critical for a multi-entity tenant like Merit)

- **The motion:** every intercompany transaction must **eliminate on consolidation** (due-to =
  due-from at all times); related-party transactions must be **at arm's length** and **disclosed**
  (ASC 850); owner activity must be correctly characterized (**loan vs. distribution vs. compensation**);
  cross-border/inter-entity pricing must satisfy **§482 transfer pricing**; S-corp **reasonable
  compensation** (officer wages vs. distributions — a top IRS audit trigger); pass-through **basis /
  capital accounts / K-1s**.
- **Leak points:** intercompany that won't eliminate → wrong consolidated financials (audit adjustment/
  restatement); disguised distributions miscoded to expense → tax + basis errors; §482 adjustments;
  blown K-1s; reasonable-comp exposure. *Canon §5 makes 11a multi-entity consolidation MANDATORY,
  top-priority — this is the accounting substance behind that gate.*

### 1.7 Entity / registered-agent / annual-report / franchise-tax compliance

- **The motion:** each legal entity must keep **good standing**: annual report / statement of
  information filings, registered-agent maintenance, **franchise tax / minimum tax** (e.g., CA $800,
  DE franchise), business-license renewals, foreign-qualification in states where it operates.
- **Leak points:** administrative **dissolution** for a missed annual report; late franchise tax
  penalties; loss of good standing that blocks financing/M&A; foreign-qualification gaps that compound
  the nexus exposure above.

### 1.8 Audit & review support (assurance — where the ledger is the moat)

- **The motion (audit):** the auditor sends a **100–300-line PBC list** ("Prepared By Client") — TB,
  GL detail, agings, fixed-asset roll, debt/covenant schedules, rec packages, **selected JE support**,
  board minutes — then performs **tie-outs** (FS→TB→GL→source), **JE testing** (AU-C 240 fraud
  standard: manual entries, round dollars, unexpected users, post-close timing, unusual account
  pairs), **cutoff testing**, **SoD/controls** documentation, confirmations, and analytics.
- **Leak points / cost:** **assembling the PBC list is the single most-hated, most-expensive part of an
  audit** — weeks of pulling documents that should already be attached to transactions; a single penny
  that won't tie burns hours; weak SoD expands testing (higher fee) or yields a **material-weakness
  letter**. An owned ledger where source docs attach **at posting** turns the PBC list into a query
  and JE testing into a filtered export — a hard-dollar **audit-fee reduction a CFO feels**.

### 1.9 Payroll-tax adjacency

Payroll tax (941/940, state UI/withholding, W-2, new-hire reporting) is owned by the **payroll
module/provider** (canon GATE 12.3; `docs/FPB-payroll.md`), not this segment — but it is a **nexus
signal** (payroll in a state) and a **book-to-tax** item (accrued vs. paid), so this segment consumes
its facts and must not re-implement it.

### 1.10 The cross-cutting liability rule (repeat, because it governs the build)

A CPA signs their name and assumes **legal liability**. They rely on AI output only if it is
**traceable, rule-cited, confidence-scored, and human-approved through an immutable trail.** Every
capability below is DETECT/CLASSIFY/DRAFT/FORECAST — **none auto-files, auto-registers, auto-remits,
or auto-elects.** The regulated act is always a human decision, and where it needs a license
(e-file, TIN match, certified rate) a **provider** performs it.

---

## PART 2 — COMPREHENSIVE CAPABILITY CATALOG (43 capabilities, grouped)

Per-item fields: **What it does · Trigger/data · Gateway bucket · Human-in-loop · Value ·
Build-state · Provider note.** Gateway buckets follow the AI-Capability-Catalog vocabulary
(EXTRACT / CLASSIFY / DETECT / DRAFT / FORECAST; plus WORKFLOW for deterministic non-AI machinery).
Build-state legend: **BUILT** (live in repo) · **PARTIAL** (substrate exists, gap named) ·
**NOT BUILT** (spec only) · **NEEDS CENTRAL** (blocked on shared-spine table/reference data).

### Group A — Sales & Use Tax (SALT)

**A1. Sales-tax economic-nexus tripwire** *(= catalog F1 / EC-7)*
- **What:** rolling trailing-12-month **invoiced revenue + transaction count by destination state** vs
  a tunable per-state economic-nexus threshold (default $100k **OR** 200 txns); alerts at ~80% of
  threshold and again on breach, with projected breach date and the exact transactions counted.
- **Trigger/data:** every posted invoice; `invoice.ship_to→state` → `bill_to→state` →
  `core.customers.state` (most-defensible-wins; fallback share discounts confidence).
- **Bucket:** DETECT. **HITL:** raises a PROPOSED `ai_decisions` row (`SALES_TAX_NEXUS`) into
  `/exceptions` with state/threshold/run-rate; human decides register / VDA / taxability study.
  **Never auto-registers.**
- **Value:** the six-figure diligence-killer, caught before breach.
- **Build-state:** **BUILT** — `apps/web/src/lib/controls/sales-tax-nexus.ts` (+ `.test.ts`,
  `api/controls/sales-tax-nexus`), detect-only, idempotent dedup key, tiers REVIEW→ESCALATE.
- **Provider:** none to detect. A per-state threshold table + registration table are **NEEDS
  CENTRAL** (see A3).

**A2. Income/franchise-tax nexus tripwire (payroll / property / inventory)**
- **What:** extends A1 beyond sales tax — flags a state where **payroll, owned/leased property, or
  inventory (3PL/FBA)** creates income- or franchise-tax filing nexus.
- **Trigger/data:** payroll-by-state (from payroll module), fixed-asset/lease locations, inventory
  warehouse locations.
- **Bucket:** DETECT. **HITL:** human confirms a new-state filing obligation; never auto-files.
- **Value:** closes the "nexus ≠ only sales tax" leak (§1.1, §1.5).
- **Build-state:** **NOT BUILT** — explicitly scoped out of A1 ("sales/use only") and flagged as the
  second EC-7 signal.
- **Provider:** none (detection); apportionment/return handoff to a tax provider (see C6).

**A3. Sales-tax registration & filing-status tracker**
- **What:** a tenant-maintained table of **state registrations** (state, registered_at, collecting
  flag, filing cadence, portal/login ref) so a crossed-but-registered state is auto-suppressed from
  A1, and a filing calendar can be driven per state.
- **Trigger/data:** human-entered on registration; consumed by A1 and the tax calendar (G2).
- **Bucket:** WORKFLOW. **HITL:** fully human-maintained system of record.
- **Value:** stops A1 crying wolf on already-registered states; anchors return-prep cadence.
- **Build-state:** **NEEDS CENTRAL** — named as missing in `sales-tax-nexus.ts` ("NEEDS CENTRAL #1").
- **Provider:** none.

**A4. Rate & taxability determination**
- **What:** for each invoice line, determine the correct **taxability** (product/service × state) and
  **rate** (state+county+city+district at ship-to) so tax is collected correctly at billing.
- **Trigger/data:** invoice line item, product/service tax code, ship-to address.
- **Bucket:** CLASSIFY (with provider lookup). **HITL:** AI/proposal for taxability mapping; human
  confirms product tax-code mapping once per SKU.
- **Value:** stops under/over-collection at the source (§1.1).
- **Build-state:** **NOT BUILT** — invoices carry no tax engine today.
- **Provider:** **licensed rate/taxability provider REQUIRED** (Avalara AvaTax, TaxJar, Vertex, or
  Stripe Tax) — jurisdiction rates and taxability rules are a maintained, certified data product;
  MeritBooks must not hand-maintain 13,000 jurisdictions.

**A5. Sales-tax liability accrual + return-prep worksheet**
- **What:** accrues **sales tax collected** to a liability account by jurisdiction and produces a
  **per-state return worksheet** (gross sales, taxable sales, exempt sales, tax due) ready for a human
  to file on the state portal.
- **Trigger/data:** taxed invoice postings (from A4); exemption certs (A7).
- **Bucket:** WORKFLOW + DRAFT (worksheet). **HITL:** human files & remits on the state portal (or a
  provider auto-files — never MeritBooks as agent).
- **Value:** turns filing into a review; ties the liability to the GL continuously.
- **Build-state:** **NOT BUILT.**
- **Provider:** filing/remittance via the A4 provider's returns service, or human on the DOR portal.

**A6. Use-tax accrual on untaxed purchases**
- **What:** at bill/expense posting, detect a **taxable purchase where no sales tax was charged**
  (out-of-state/online vendor, taxable category, ship-to a nexus state) and propose a **self-assessed
  use-tax accrual**.
- **Trigger/data:** bill line, vendor state, tax-charged flag on the bill, buyer location taxability.
- **Bucket:** DETECT/CLASSIFY. **HITL:** human confirms the accrual (a judgment on taxability).
- **Value:** closes the near-universal use-tax leak — the first thing a state auditor tests (§1.1).
- **Build-state:** **NOT BUILT.**
- **Provider:** taxability lookup shares the A4 provider.

**A7. Exemption-certificate management**
- **What:** stores and tracks **customer resale/exemption certificates** (by customer × state), flags
  **missing/expired** certs against exempt sales, and blocks/flags an exempt sale with no valid cert.
- **Trigger/data:** exempt invoice; cert on file with expiry; per-state cert rules.
- **Bucket:** DETECT + WORKFLOW. **HITL:** human collects the cert (chase reuses the Vendor-Compliance
  doc-chase engine pattern).
- **Value:** an exempt sale with no cert becomes taxable on audit — this closes it (§1.1).
- **Build-state:** **NOT BUILT** (the vendor-side doc-chase machinery in `vendor-compliance.ts` is the
  reusable substrate; customer-side certs are new).
- **Provider:** cert validation/storage available from the A4 provider (e.g., Avalara CertCapture),
  optional.

**A8. Marketplace-facilitator / 1099-K interplay reconciliation**
- **What:** reconcile marketplace-facilitator-collected sales tax and card/third-party-network volume
  so those channels are excluded from the seller's own liability (A5) and from 1099-NEC (B3).
- **Trigger/data:** payment rail on each transaction (card vs. ACH/check), marketplace channel tag.
- **Bucket:** CLASSIFY. **HITL:** review of channel mapping.
- **Value:** stops double-counting tax/1099 on facilitated/card channels.
- **Build-state:** **PARTIAL** — the **rail split** exists and is proven in 1099 readiness
  (`readiness.ts` `isReportableRail`); marketplace-facilitator sales-tax side is NOT BUILT.
- **Provider:** none.

### Group B — Information Returns (1099 / W-9 / TIN)

**B1. W-9 collection at vendor onboarding + payment gate** *(= catalog B2)*
- **What:** requires a **W-9 before first payment**; a vendor with a missing/expired W-9 (or COI) is
  auto-**payment-held** until cured or a documented override is granted.
- **Trigger/data:** vendor creation; `vendor_compliance_docs`; bill-pay attempt.
- **Bucket:** DETECT + WORKFLOW (auto-chase). **HITL:** override with reason (audit-logged); human
  releases the hold.
- **Value:** kills the January W-9 chase by collecting up front (§1.2).
- **Build-state:** **BUILT** — migration 037 (computed hold + override lifecycle), `vendor-compliance.ts`,
  `/vendor-compliance` page, `api/vendor-compliance`.
- **Provider:** none.

**B2. TIN matching against the IRS database**
- **What:** validate each vendor **name+TIN** against the IRS TIN-matching service to catch a mismatch
  **before** it becomes a CP2100/backup-withholding event.
- **Trigger/data:** vendor TIN + legal name at onboarding and pre-filing.
- **Bucket:** DETECT (via provider). **HITL:** human resolves a mismatch (re-request W-9).
- **Value:** prevents the 24% backup-withholding liability and B-notice penalty cycle (§1.2).
- **Build-state:** **PARTIAL** — the readiness engine tracks `tinPresent` (presence), but there is **no
  actual IRS TIN match**.
- **Provider:** **REQUIRED** — IRS TIN Matching (bulk/interactive) or a filing provider that offers it
  (Tax1099, Track1099). MeritBooks stores the result; the provider performs the match.

**B3. 1099-NEC/MISC readiness dashboard (year-round, rail-split)** *(= catalog F3 / EC-8)*
- **What:** tracks reportable vendors (unincorporated, **≥ $600**, by reportable rail — **excluding**
  card/3rd-party-network already on 1099-K), classifies each **READY / MISSING_W9 / NOT_MARKED_1099**,
  and surfaces **$ at risk** behind undocumented candidates, sorted gaps-first.
- **Trigger/data:** POSTED `bill_payments` in the tax year → `bills.vendor_id` → `core.vendors`
  (is_1099_eligible / tin / w9_status) + `vendor_compliance_docs` (to catch EXPIRED).
- **Bucket:** DETECT. **HITL:** human works the gap list; filing is a human-triggered batch.
- **Value:** turns a spreadsheet fire drill into a year-round query off the owned ledger (§1.2).
- **Build-state:** **BUILT** — `api/compliance/1099/readiness.ts` (+ route, `/compliance-1099` page &
  client). Rail-split correct; $600 floor correct.
- **Provider:** none to compute readiness; e-file is B4.

**B4. 1099 e-file (IRS + state) & recipient delivery**
- **What:** generate and **e-file** the 1099-NEC/MISC batch to the IRS (IRIS/FIRE) and applicable
  states, and deliver recipient copies.
- **Trigger/data:** the READY set from B3, human-approved.
- **Bucket:** WORKFLOW (via provider). **HITL:** human triggers the batch; reviews before transmit.
- **Value:** completes the 1099 loop without MeritBooks becoming the transmitter of record.
- **Build-state:** **NOT BUILT.**
- **Provider:** **REQUIRED** — Track1099 / Tax1099 / Sovos (also covers recipient delivery + state
  filing + TIN match). MeritBooks supplies the data file; the provider transmits.

**B5. Backup-withholding trigger & accrual**
- **What:** when a reportable vendor has no valid W-9/TIN (or a B-notice), compute and **accrue 24%
  backup withholding** on payments and flag it for remittance.
- **Trigger/data:** payment to a vendor in MISSING_W9 state (from B1/B3).
- **Bucket:** DETECT + WORKFLOW. **HITL:** human authorizes withholding/remittance.
- **Value:** converts a silent payer liability into a managed accrual (§1.2).
- **Build-state:** **NOT BUILT.**
- **Provider:** remittance via payroll-tax/1099 provider.

### Group C — Income Tax, Provision & Book-to-Tax

**C1. Book-to-tax difference tagging (M-1/M-3)** *(= catalog F2 / EC-9 — "the single richest AI opportunity")*
- **What:** at posting, tag each expense/revenue line's **tax character** (meals 50%, entertainment
  0%, penalties/fines 0%, federal tax, tax-exempt income, §179/bonus vs. book depr, bad-debt reserve
  vs. write-off, accruals, prepaids, §174 R&D) and maintain a **running M-1/M-3 bridge** as a ledger
  dimension that ties to the GL by construction.
- **Trigger/data:** every expense/revenue posting; account role, vendor, memo, amount, source doc.
- **Bucket:** CLASSIFY. **HITL:** high-confidence common cases auto-tag (logged, Code-section-cited);
  CPA confirms edge cases at review.
- **Value:** turns a 40-hour M-1 reconstruction into a review; book NI moves 5–25% today (§1.3).
- **Build-state:** **NOT BUILT** — no code; specified in FPB EC-9 and catalog F2. *The single highest-
  leverage unbuilt tax capability.*
- **Provider:** none (rules are Code, cited inline).

**C2. Temporary vs. permanent classification (ASC 740 dimension)**
- **What:** classify each C1 difference **temporary vs. permanent**, the input the tax provision needs.
- **Trigger/data:** the M-1 tag from C1.
- **Bucket:** CLASSIFY. **HITL:** CPA confirms at provision time.
- **Value:** the missing dimension behind the #1 private-company restatement source (§1.3).
- **Build-state:** **NOT BUILT** (rides on C1).
- **Provider:** none.

**C3. Deferred-tax rollforward (DTA/DTL)**
- **What:** roll forward deferred tax assets/liabilities from the temporary-difference balances (C2) ×
  the enacted rate; flag valuation-allowance triggers.
- **Trigger/data:** temp-difference balances by category; enacted rate (from a params table like the
  tax-year params).
- **Bucket:** WORKFLOW + FORECAST. **HITL:** CPA reviews the rollforward and valuation allowance.
- **Value:** deferred tax becomes a rollforward that ties to the GL, not a drifting spreadsheet (§1.3).
- **Build-state:** **NOT BUILT.** (Tax-vs-book **depreciation** timing difference substrate exists —
  migration 033 tracks `accumulated_depreciation` (book) − `tax_accumulated_depreciation` (tax) — so
  the depreciation DTL is partially seeded.)
- **Provider:** none.

**C4. Income-tax provision (current + deferred, rate rec, FIN 48)**
- **What:** compute current + deferred tax expense, the effective-rate reconciliation, and track
  uncertain tax positions (FIN 48) for the financial statements.
- **Trigger/data:** taxable-income bridge (C1/C2), DTA/DTL (C3), rate params.
- **Bucket:** WORKFLOW + DRAFT. **HITL:** CPA owns and signs the provision.
- **Value:** the review/audit-adjacent deliverable, pre-assembled from the ledger (§1.3).
- **Build-state:** **NOT BUILT.**
- **Provider:** none required; complex returns still go to a tax provider (C6).

**C5. Estimated-payment scheduler + safe-harbor math**
- **What:** project taxable income, compute quarterly estimates, apply **safe harbor (100/110% prior
  year)**, and schedule reminders to avoid underpayment penalties.
- **Trigger/data:** YTD taxable-income bridge; prior-year tax; entity type.
- **Bucket:** FORECAST + WORKFLOW (calendar). **HITL:** human authorizes each payment (never
  auto-remits).
- **Value:** stops underpayment-penalty leak; a live cash-planning tool (§1.3).
- **Build-state:** **NOT BUILT.**
- **Provider:** remittance via EFTPS/state portal by a human.

**C6. Multistate apportionment factors**
- **What:** compute **sales/payroll/property apportionment** per state (single-sales-factor default;
  3-factor where required) feeding state income-tax returns and PTET decisions.
- **Trigger/data:** revenue by state (A1 substrate), payroll by state (A2), property by state.
- **Bucket:** WORKFLOW. **HITL:** CPA reviews sourcing; return prep handed to a tax provider.
- **Value:** correct state filing footprint; PTET decision support (§1.5).
- **Build-state:** **NOT BUILT** (revenue-by-state substrate exists in A1).
- **Provider:** state income-tax **return preparation** is a licensed act — hand the apportionment
  workpaper to the client's CPA/tax software (CCH, Lacerte, UltraTax); MeritBooks does not file it.

**C7. PTET / composite election tracker**
- **What:** flag states where a **PTET/composite** election is available and beneficial, with the
  election deadline, and track the elected status.
- **Trigger/data:** nexus states (A2), entity type, owner residency.
- **Bucket:** DETECT + WORKFLOW (calendar). **HITL:** the election is the taxpayer's decision.
- **Value:** a hard-dollar SALT-cap workaround frequently missed (§1.5).
- **Build-state:** **NOT BUILT.**
- **Provider:** none (election filed by the CPA).

**C8. R&D / §174 capitalization capture + credit support**
- **What:** identify **§174 R&D expenditures** (now mandatorily capitalized/amortized) from the ledger
  and assemble the **§41 R&D credit** wage/supply/contract-research substrate.
- **Trigger/data:** payroll by activity, contractor spend, supply spend tagged to qualifying projects.
- **Bucket:** DETECT/CLASSIFY. **HITL:** CPA/specialist confirms qualification (a documentation-heavy
  judgment).
- **Value:** captures a credit most SMBs under-claim; §174 capitalization is now unavoidable.
- **Build-state:** **NOT BUILT.**
- **Provider:** R&D credit studies are typically specialist-performed; MeritBooks supplies evidence.

**C9. Other credits capture (WOTC, energy, etc.)**
- **What:** surface eligibility signals for common business credits (WOTC on new hires, §179D/energy,
  state credits) from ledger + payroll facts.
- **Trigger/data:** new-hire data, capex categories, location incentives.
- **Bucket:** DETECT. **HITL:** specialist confirms; MeritBooks flags and documents.
- **Value:** recovers commonly-missed credits.
- **Build-state:** **NOT BUILT.**
- **Provider:** WOTC certification is state-agency-driven (provider-assisted).

### Group D — Fixed Assets & Depreciation (tax lifecycle)

**D1. Capex-vs-expense classifier + de-minimis safe harbor** *(= catalog B5, first half)*
- **What:** on any payment above a threshold to a capex-suggestive account/vendor, prompt
  **capitalize vs. expense** with the **de-minimis safe harbor ($2,500/$5,000)** and repair-vs-
  improvement (RABI) test; on capitalize, auto-create the fixed-asset record.
- **Trigger/data:** bill/payment line, account role, amount, vendor.
- **Bucket:** CLASSIFY + DRAFT. **HITL:** human confirms the classification and the safe-harbor
  election posture.
- **Value:** stops the expense/capitalize misclassification leak at the source (§1.4).
- **Build-state:** **PARTIAL** — fixed-asset provisioning/disposal machinery exists
  (`lib/posting/provisioning.ts`, `asset-disposal.ts`, `/fixed-assets` page); the **at-posting
  capex-vs-expense prompt with safe-harbor/RABI** is NOT wired.
- **Provider:** none.

**D2. Dual-book depreciation (book SL vs. tax MACRS/§179/bonus)**
- **What:** the financial GL carries **book** depreciation (straight-line, posted); a **parallel tax**
  schedule computes MACRS (half-year tables), §179, and bonus **without touching the GL**, producing
  the book-vs-tax timing difference.
- **Trigger/data:** `fixed_assets` tax columns; `tax_year_params` (§179 cap/phaseout, bonus %).
- **Bucket:** WORKFLOW (deterministic engine). **HITL:** run is reviewable; elections are D3.
- **Value:** the depreciation half of the deferred-tax picture, correct by construction (§1.4).
- **Build-state:** **BUILT** — migration 033 (tax cols + `tax_depreciation_runs`), migration 034
  (`tax_year_params`, seeded 2024–2026 with a `confirmed` flag), engine
  `lib/posting/tax-depreciation.ts` (MACRS 3/5/7/10/15/20-yr half-year tables, §179, bonus).
  *Gap: MID_QUARTER / MID_MONTH conventions are reported unsupported, not computed.*
- **Provider:** none.

**D3. §179 / bonus / de-minimis election presenter**
- **What:** present the year-1 **election** (the annual, often-irrevocable §179/bonus/safe-harbor
  choice) as an explicit, timestamped **human** decision — never auto-elect.
- **Trigger/data:** new capitalized asset; `tax_year_params` defaults; asset class.
- **Bucket:** DRAFT (proposes; human elects). **HITL:** the election **is** the human act (legally the
  taxpayer's).
- **Value:** prevents permanently-lost deductions from missed elections; audit-defensible election
  record (§1.4).
- **Build-state:** **PARTIAL** — the engine *applies* §179/bonus inputs (D2), and `tax_year_params`
  carries a `confirmed` human-gate on statutory values, but a **per-asset election-presentation UI**
  with the RABI/safe-harbor rationale captured is NOT built.
- **Provider:** none.

**D4. Disposition & depreciation-recapture tracking**
- **What:** on asset sale/scrap, stop depreciation, compute gain/loss and **§1245/1250 recapture**,
  and catch **assets sold but still depreciating**.
- **Trigger/data:** disposal event; book & tax accumulated depreciation; proceeds.
- **Bucket:** DETECT + WORKFLOW. **HITL:** human confirms disposal terms.
- **Value:** closes the "still depreciating a sold asset" permanent-overstatement leak (§1.4).
- **Build-state:** **PARTIAL** — `lib/posting/asset-disposal.ts` exists (book disposal); tax
  recapture + the "orphaned depreciation" detector are NOT confirmed built.
- **Provider:** none.

**D5. Tax-year statutory-parameter management**
- **What:** maintain per-tax-year **§179 cap/phase-out and bonus %**; the AI proposes the new year's
  values (confirmed=false, source-cited) and a human confirms before they drive tax numbers.
- **Trigger/data:** annual IRS revenue procedure / statute (e.g., OBBBA 2025 100% bonus).
- **Bucket:** DRAFT (AI proposes; human confirms). **HITL:** `confirmed` flag gates use.
- **Value:** statutory values never silently auto-apply; 2026 is seeded UNCONFIRMED by design.
- **Build-state:** **BUILT** — migration 034 `tax_year_params` + `seed_tax_year_params()`.
- **Provider:** none (values are public statute; a data feed could pre-fill the proposal).

### Group E — Related-Party / Intercompany / Multi-Entity

**E1. Intercompany matching & elimination** *(= EC-3)*
- **What:** continuous reconciliation that **due-to = due-from** at all times across entities/
  departments; detects out-of-balance intercompany positions that block a clean consolidation and
  drafts the correcting entry for a human.
- **Trigger/data:** per-period intercompany balances (`INTERCOMPANY_AR` 1160 / `INTERCOMPANY_AP` 2020,
  `counterparty_location_id`); three balance assertions.
- **Bucket:** DETECT. **HITL:** human applies the proposed mirror/elimination; never auto-posts.
- **Value:** correct consolidated financials; the accounting substance behind mandatory GATE 11a
  (§1.6).
- **Build-state:** **BUILT** — migration 035 (intercompany due-to/due-from + pairing),
  `lib/controls/intercompany-balance.ts` (+ test, api), `/intercompany` page. Detect-only.
- **Provider:** none.

**E2. Related-party transaction flagging + ASC 850 disclosure schedule**
- **What:** flag any transaction whose counterparty is a **known related entity/owner** (from the
  `core` entity/ownership graph), require the mirror side, and generate the **ASC 850 disclosure
  schedule** as a byproduct.
- **Trigger/data:** counterparty vs. related-party graph; transaction posting.
- **Bucket:** DETECT. **HITL:** human characterizes related-party pricing/terms.
- **Value:** ASC 850 disclosure and consolidation workpaper fall out of the ledger (§1.6).
- **Build-state:** **PARTIAL** — intercompany *entity* pairing exists (E1); an explicit **related-party
  graph + disclosure schedule** (esp. owner-level) is NOT built.
- **Provider:** none.

**E3. Owner-benefit / disguised-distribution classifier**
- **What:** flag owner-related payments miscoded to expense and prompt **loan vs. distribution vs.
  compensation** characterization.
- **Trigger/data:** payments to owner/related parties; account coded.
- **Bucket:** DETECT/CLASSIFY. **HITL:** human (CPA) makes the characterization call.
- **Value:** prevents disguised distributions → tax + basis errors; K-1 integrity (§1.6).
- **Build-state:** **NOT BUILT.**
- **Provider:** none.

**E4. S-corp reasonable-compensation monitor**
- **What:** monitor officer **wages vs. distributions** ratio against reasonable-comp benchmarks and
  flag exposure (a top IRS audit trigger).
- **Trigger/data:** officer payroll vs. distributions; entity type = S-corp.
- **Bucket:** DETECT. **HITL:** CPA judgment on "reasonable."
- **Value:** reduces a common S-corp audit trigger (§1.6).
- **Build-state:** **NOT BUILT.**
- **Provider:** comp-benchmark data optional (RCReports-style).

**E5. Transfer-pricing / §482 flag**
- **What:** flag inter-entity (esp. cross-border) transactions priced off arm's-length and surface
  §482 documentation exposure.
- **Trigger/data:** intercompany pricing vs. benchmarks; cross-jurisdiction pairs.
- **Bucket:** DETECT. **HITL:** specialist confirms; MeritBooks documents.
- **Value:** §482 adjustment exposure surfaced (§1.6).
- **Build-state:** **NOT BUILT.**
- **Provider:** transfer-pricing studies are specialist-performed.

**E6. Basis / capital-account / K-1 roll (pass-through)**
- **What:** maintain per-owner **stock/debt basis** (S-corp) and **tax-basis capital accounts**
  (partnership, now mandatory) and roll to **K-1s** — impossible to do correctly if intercompany/owner
  activity is dirty (which E1–E3 keep clean).
- **Trigger/data:** contributions, distributions, allocated income, guaranteed payments.
- **Bucket:** WORKFLOW. **HITL:** CPA reviews allocations and K-1s.
- **Value:** correct K-1s and loss-limitation math for a multi-entity/PE-style tenant (§1.6).
- **Build-state:** **NOT BUILT.**
- **Provider:** K-1 issuance via tax software; MeritBooks supplies the roll.

### Group F — Audit / Assurance / Controls (audit-defensible by construction)

**F1. Anomalous / unsupported journal-entry detection (AU-C 240)** *(= EC-10)*
- **What:** at posting, score every manual JE on round-dollar, missing/weak description, missing
  attachment, unusual account combination, timing (post-close/weekend/period-end), and preparer
  identity — the exact population auditors extract.
- **Trigger/data:** each manual JE + its metadata.
- **Bucket:** DETECT/score. **HITL:** low-risk posts with logging; high-risk requires description +
  attachment + approver before posting.
- **Value:** hands the auditor the **entire manual-JE population pre-scored** — JE testing becomes a
  filtered query (§1.8).
- **Build-state:** **BUILT** — `lib/controls/anomalous-je.ts` (+ test, api). Detect-only.
- **Provider:** none.

**F2. Revenue & expense cutoff enforcement** *(= catalog F4 / EC-12)*
- **What:** near period-end, compare invoice/bill date vs. delivery/performance evidence and flag
  likely mis-cut items; honor the deterministic rev-rec deferral rule (managed job credits Deferred
  Revenue 2410, not Revenue).
- **Trigger/data:** entries within N days of close; ship/progress/milestone evidence.
- **Bucket:** DETECT. **HITL:** human confirms the period; AI never invents % complete.
- **Value:** pre-answers the auditor's cutoff test; prevents covenant/tax timing errors (§1.3, §1.8).
- **Build-state:** **BUILT** — `lib/controls/cutoff-errors.ts` (+ test, api). Detect-only.
- **Provider:** none.

**F3. PBC-list / tie-out automation (assurance evidence pack)**
- **What:** because source docs attach **at posting** and every FS figure traces to the GL, generate
  the standard **PBC deliverables** (TB, GL detail, agings, fixed-asset roll, debt/covenant schedules,
  rec packages, selected-JE support) plus a **continuous tie-out** flagging any FS→TB→GL→source break.
- **Trigger/data:** ledger + attached provenance; auditor request.
- **Bucket:** WORKFLOW (read-only export). **HITL:** auditor-driven; no auto-representations.
- **Value:** the weeks-long PBC scramble becomes a query — **the hard-dollar audit-fee ROI a CFO buys
  the platform for** (§1.8).
- **Build-state:** **NOT BUILT** (the provenance substrate — attachments, audit_log, working_papers in
  migration 007 — largely exists; the packaged export/tie-out does not).
- **Provider:** none.

**F4. Segregation-of-duties / audit-trail control matrix**
- **What:** enforce **preparer ≠ approver** on money movement, immutable **period locks**, and full
  human-attributed audit trail; continuously test **SoD** across role assignments and flag conflicts
  (same person creates a vendor and pays it; approves and posts).
- **Trigger/data:** `core.memberships/roles`, money-movement approvals, `action_log`, period status.
- **Bucket:** DETECT + WORKFLOW. **HITL:** the control *is* the human posture; AI monitors and reports.
- **Value:** the "controls understanding" an auditor documents first — hand it over prebuilt (§1.8).
- **Build-state:** **PARTIAL** — preparer≠approver (migration 042/043 + service + DB CHECK), period
  locks (`enforce_period_lock`), `action_log` (migration 062) are BUILT; the **generated SoD-conflict
  matrix report** is NOT built, and full defensibility waits on the identity gate #9 close (canon §3
  flags the residual `canApprove`/org-resolution work).
- **Provider:** none.

### Group G — Entity Compliance & Tax Calendar

**G1. Generic regulatory obligation/filing tracker**
- **What:** per-entity **compliance obligations** (name, frequency, jurisdiction) and **filings** grid
  with status (FILED / OVERDUE / PENDING / upcoming), expected vs. filed amounts.
- **Trigger/data:** `compliance_obligations` + `compliance_filings`; per-location.
- **Bucket:** WORKFLOW + DETECT (overdue). **HITL:** human marks filed.
- **Value:** a single pane for filing status; the substrate for tax-specific calendars.
- **Build-state:** **BUILT** — migration 007 (`compliance_obligations`, `compliance_filings`),
  `/compliance` page + api. Generic (not tax-seeded).
- **Provider:** none.

**G2. Tax-calendar automation (federal / state / local due dates)**
- **What:** auto-generate the **tax filing calendar** — sales-tax returns per state cadence (from A3),
  1099 Jan-31, income-tax/estimates (C5), franchise/annual reports (G3) — with escalating reminders.
- **Trigger/data:** registrations (A3), entity states (A2), entity type; a maintained due-date rule
  set.
- **Bucket:** WORKFLOW + DRAFT (reminders). **HITL:** human files; system reminds and tracks.
- **Value:** no missed deadline across a multi-entity, multistate footprint (§1.1, §1.7).
- **Build-state:** **PARTIAL** — the generic obligation/filing engine (G1) is the substrate; **tax-
  specific seeding and rule-driven auto-generation** are NOT built.
- **Provider:** a due-date rule-set data feed optional.

**G3. Entity / registered-agent / annual-report / franchise-tax compliance calendar**
- **What:** track each legal entity's **good-standing** obligations — annual report / statement of
  information, registered-agent status, franchise/minimum tax, foreign qualifications, business
  licenses — with deadlines and renewal reminders.
- **Trigger/data:** `core` entity registry; state formation/qualification data.
- **Bucket:** WORKFLOW + DETECT. **HITL:** human files renewals.
- **Value:** prevents administrative dissolution and franchise-tax penalties that block financing/M&A
  (§1.7).
- **Build-state:** **NOT BUILT** (could extend G1's obligation model to the entity level).
- **Provider:** registered-agent + annual-report filing typically via a CSC/CT/Harbor-Compliance-style
  provider; MeritBooks tracks and hands off.

**G4. Business-license / secretary-of-state good-standing monitor**
- **What:** monitor SoS good-standing status and license renewals per entity/jurisdiction.
- **Trigger/data:** entity registry; license inventory; SoS status.
- **Bucket:** DETECT. **HITL:** human renews.
- **Value:** compounds with A2/A3 to close the full multistate footprint (§1.7).
- **Build-state:** **NOT BUILT.**
- **Provider:** good-standing/license data via a compliance provider, optional.

---

### Build-state census (43 capabilities)

- **BUILT (10):** A1 nexus tripwire, B1 W-9/COI gate, B3 1099 readiness, D2 dual-book depreciation,
  D5 tax-year params, E1 intercompany matching, F1 anomalous-JE, F2 cutoff, G1 obligation tracker,
  (plus year-end close 038 as supporting machinery).
- **PARTIAL (8):** A8 rail-split (1099-side only), B2 TIN presence (no IRS match), D1 capex classifier,
  D3 election presenter, D4 disposition/recapture, E2 related-party/ASC 850, F4 SoD matrix, G2 tax
  calendar.
- **NEEDS CENTRAL (1):** A3 registration tracker (shared reference/registration table).
- **NOT BUILT (24):** A2, A4, A5, A6, A7; B4, B5; C1, C2, C3, C4, C5, C6, C7, C8, C9; E3, E4, E5, E6;
  F3; G3, G4.

**Provider-gated (never the regulated party):** A4/A5 (rate/taxability/returns — Avalara/TaxJar/
Vertex/Stripe Tax), B2 (IRS TIN match), B4 (1099 e-file — Track1099/Tax1099/Sovos), B5 (backup-
withholding remittance), C6 (state return prep — CCH/Lacerte/UltraTax), C8/C9 (R&D/WOTC studies),
G3/G4 (registered-agent/annual-report — CSC/CT/Harbor Compliance). In every case MeritBooks produces
the audit-defensible evidence/data file and a human or provider performs the regulated act.

---

## PART 3 — RANKED BUILD-FIRST SHORTLIST → GATES (each needs an FPB)

Sequencing logic (from the CPA brief Part C + canon gate order): the highest-leverage tax/compliance
work is **dimensions and checks layered onto the posting path already owned** — they don't need the
segment engines to exist first. Ship the assurance/provenance and book-to-tax moat early; gate the
SALT collection engine behind the sales-tax gate (11d) and its licensed provider.

| # | Capability | Why first | Gate | FPB status |
|---|---|---|---|---|
| **1** | **C1+C2 Book-to-tax tagging (M-1/M-3) + temp/perm** | "Single richest AI opportunity"; pure posting-path dimension; feeds provision + audit; nothing blocks it | GATE 7/8 (tax moat) | EC-9 exists in FPB-financial-control-exceptions; **needs its own module FPB** (16-dim) |
| **2** | **F3 PBC / tie-out assurance pack** | Highest hard-dollar ROI a CFO feels; ~90% substrate (attachments, audit_log, working_papers) already present | GATE 8 (reporting/assurance) | **NEW FPB required** (assurance evidence module) |
| **3** | **A3+A2 Registration tracker + income/franchise nexus** | Unblocks A1 (stops false positives), extends the already-built tripwire to income/franchise — cheap, high-value; A3 is a shared-spine table | GATE 11d (sales tax) prereq | Extend EC-7 FPB; **A3 table needs central-schema FPB note** |
| **4** | **D1+D3+D4 Fixed-asset tax lifecycle completion** | D2/D5 already built; wiring the at-posting capex classifier, election presenter, and disposition/recapture completes a mostly-done engine | GATE 8 | **NEW FPB** (fixed-asset tax lifecycle) — catalog B5 |
| **5** | **B2+B4+B5 1099 completion (TIN match, e-file, backup withholding)** | B1/B3 built; completing the loop is provider-integration work with clear boundaries; common-core US | extends GATE (Vendor Compliance) | Extend EC-8/F3 FPB with the **provider-integration + backup-withholding** spec |
| **6** | **E2+E3 Related-party graph + owner-benefit classifier** | Direct substance behind mandatory GATE 11a consolidation; E1 already built | GATE 11a (multi-entity, top priority) | Fold into the **consolidation FPB** (`FPB-tenant-model-consolidation-analytics.md`) |
| **7** | **A4+A5+A6+A7 SALT collection engine (rate/taxability/returns/use-tax/exemption)** | Highest-$ but heaviest: needs a licensed provider + the sales-tax gate; do after the tripwire+registration foundation | GATE 11d (sales tax) | **NEW FPB** (SALT engine) — must specify the provider seam and the never-the-regulated-party boundary |
| **8** | **C3+C4+C5 Provision + deferred tax + estimates** | Depends on C1/C2 landing first; then it's a rollforward | GATE 7/8 | Fold into the book-to-tax module FPB (#1) as a phase 2 |

**FPB requirement (canon §4, Rules 13–16):** none of the eight is "buildable from a one-line
description." Each needs a field-level FPB (Purpose · UI · AI behavior · Data model · Validation/
gates · testable Acceptance criteria) with the 16 dimensions incl. a **QBO/Sage/best-in-class
benchmark with named deltas** and the **provider-seam / never-the-regulated-party boundary stated
explicitly** wherever Group A/B/C/G touches a licensed act. Shortlist items #1, #2, #4, #7 warrant
**net-new module FPBs**; #3, #5, #6, #8 **extend existing FPBs**. No item may start before its
`Prereq:` gate is DONE, and the A3 registration table and any per-state threshold/rate reference
data serialize through the lead as shared-spine schema (Supabase-first).

---

## Appendix — Key repo references (build-state provenance)

- Sales-tax nexus: `apps/web/src/lib/controls/sales-tax-nexus.ts` (+ `.test.ts`,
  `apps/web/src/app/api/controls/sales-tax-nexus/route.ts`).
- 1099/W-9: `apps/web/src/app/api/compliance/1099/readiness.ts` (+ route),
  `apps/web/src/app/(app)/compliance-1099/`; vendor compliance `lib/services/vendor-compliance.ts`,
  migration `037_vendor_compliance_enforcement.sql`, `/vendor-compliance`.
- Dual-book tax depreciation: migrations `033_dual_book_tax_depreciation.sql`,
  `034_tax_year_params.sql`; engine `apps/web/src/lib/posting/tax-depreciation.ts`;
  `lib/posting/asset-disposal.ts`, `provisioning.ts`; `/fixed-assets`.
- Intercompany: migration `035_intercompany.sql`; `lib/controls/intercompany-balance.ts`;
  `/intercompany`.
- Anomalous JE / cutoff: `lib/controls/anomalous-je.ts`, `lib/controls/cutoff-errors.ts`.
- Compliance calendar: migration `007_close_audit_compliance.sql` (`compliance_obligations`,
  `compliance_filings`, `working_papers`, `audit_log`); `/compliance`; year-end close
  `038_year_end_close.sql`, `/year-end-close`.
- Governing docs: `docs/discovery/books/cpa-tax-assurance.md`,
  `docs/discovery/books/AI-CAPABILITY-CATALOG.md` §F,
  `docs/FPB-financial-control-exceptions.md` (EC-7/8/9/10/12), `docs/canon/CANON-ANCHOR.md`.
