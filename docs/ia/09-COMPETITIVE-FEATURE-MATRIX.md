# MeritBooks — Competitive Feature Matrix (singular accounting & finance platform)

**Status:** research / reference · authored 2026-10-20 · read-only (no code or schema changed).
**Owner ask:** "do you have a list of all of the leading systems that this is competing with to make it a singular platform
for accounting and finance functions — bill.com, sage, quickbooks, jirav, ramp, concur, double, and any other leading software
out there. what are we missing, what should we add, what can we do better." Plus: "have you looked at the systems I mentioned
(ServiceTitan, Buildertrend, Innergy, simPRO, RFMS, C-Systems) to see what features they have that we may want to adopt."

**Builds on, does not repeat:** `docs/COMPETITIVE-GAP-ANALYSIS-2026-10.md` (**CG#n**, AI-native ledgers + Ramp + the build order),
`docs/ia/04-CAPABILITY-MAP.md` (**346 capabilities**; IDs like `AP-11` are used for MeritBooks status below), and
`docs/ia/07-INTEGRATIONS-PLAN.md` (API reality of the six named field systems, bridge lane, connector framework). Where this file
says "see 07", the integration mechanics are already specified there.

**Canon guardrails applied** (`docs/canon/CANON-ANCHOR.md`): MeritBooks owns the GL; QBO/Sage/Xero are migration sources only.
The workforce chargeback / overhead burden-rate / 5-labor-class engine and **in-app time tracking are RETIRED**. Time lives in
the PM module or comes in from a time/payroll provider. Nothing below proposes rebuilding them. Money movement goes through
licensed providers, never with Books as the regulated party (MD G12.2).

**Evidence tags:**
- **[P]** = vendor's own page or docs.
- **[3P]** = third party (aggregator, reseller, review site, competitor blog). Treat as a lead.
- **[U]** = **unverified**: background knowledge with no source fetched this session. Verify before quoting externally.
- **[R]** = this repo.
- **[J]** = my judgment (priority, effort).

Vendor accuracy and automation figures are vendor claims.

**Research limits (be honest about these):**
- Six parallel research passes shared one 200-search web budget, which ran out.
- Reddit could not be searched or fetched.
- Gaps by area:
  - The tax/COI vendors (Avalara, Anrok, TaxJar, Track1099/Tax1099, Zenwork, myCOI, Certificial, TrustLayer, Billy, Jones) are **[U]**.
  - So are RFMS and c-Systems feature detail beyond what 07 already cites, Procore finance detail, JobTread, and the feature pages for Jobber, Housecall Pro and FieldEdge.
  - Concur, Expensify, Navan, Emburse, Airbase, Mercury and Rho are thin.
- A follow-up message with fresh search budget can close these; the list is in §7.
- **Time-sensitive:** Intuit Connect runs **Oct 26–28, 2026**, so expect new Intuit agent and IES announcements. Recheck §1-A and §4 after it
  ([3P](https://insightfulaccountant.com/events/intuit-connect-2026/)).

---

## 0. Executive summary

1. **Nobody sells the singular platform for this segment.** Three groups exist and none of them spans it:
   - **Ledgers** (QBO, Xero, Intacct, NetSuite, the AI-native GLs).
   - **Bolt-on layers** (BILL, Ramp, Tipalti, Jirav/Fathom, Double/Karbon, Avalara, myCOI). Every one of these *sits on top of a ledger it does not own*.
   - **Field systems** (ServiceTitan, Buildertrend, simPRO, RFMS, Innergy, c-Systems). These push batches into QuickBooks.

   A Merit-style holdco today pays for and reconciles 8–12 tools per entity. MeritBooks' pitch is that the book of record does
   the work the bolt-ons do, natively, across entities.
2. **The AI-native GLs (Rillet, Campfire, DualEntry, Digits, Puzzle) are all built for SaaS companies.** Their revenue
   recognition is driven by Stripe and Salesforce. **None has job cost, WIP, AIA billing, retainage or lien waivers**
   ([P Rillet llms.txt](https://rillet.com/llms.txt), [P Campfire llms.txt](https://campfire.ai/llms.txt), [3P DualEntry](https://tooliverse.ai/tools/dualentry)).
   The trades-capable ledgers (Sage 300 CRE, Intacct Construction, Acumatica, IES Construction) are legacy or retrofitted. An
   **AI-native multi-entity ledger with trades depth is open white space.**
3. **The closest threat is Intuit Enterprise Suite.** Its May 2026 release added transaction-level intercompany eliminations,
   multi-level hierarchies, **cross-entity bill pay that auto-creates intercompany JEs**, and dimensional reporting. Its
   Feb 2026 Construction edition added WIP and job costing
   ([3P CPA Practice Advisor](https://www.cpapracticeadvisor.com/2026/05/13/intuit-announces-several-enhancements-to-enterprise-suite/183362/)).
   Intuit migrates QuickBooks Desktop users for free (a "$9,000 value", "within 72 hours") ([P](https://erp.intuit.com/migration/)).
   Limits:
   - IES still runs on the QBO platform ([P Ramp](https://support.ramp.com/hc/en-us/articles/49904858586131-Ramp-support-for-QuickBooks-Online-QBO-and-Intuit-Enterprise-Suite-IES)).
   - A job posting shows retainage, pay-when-paid and lien waivers are still only *planned*
     ([3P job posting](https://jobs.anitab.org/companies/intuit/jobs/79819335-principal-product-manager-ai-native-construction-field-services)).
4. **Ramp is coming into trades from the spend side.** Ramp for Construction (July 2026) checks lien waivers and COIs before
   payment and pulls job costing from the ERP ([P](https://ramp.com/blog/new-on-ramp-july-edition-26)). Ramp is now embedded in
   ServiceTitan's AP (Sept 30 2026) ([P](https://www.servicetitan.com/press/servicetitan-announces-strategic-partnership-with-ramp-to-automate-financial-workflows-for-contractors-with-ai-powered-tools)).
   This confirms CG §2: **partner with Ramp for cards and spend capture; MeritBooks owns ledger, close, consolidation and reporting.**
5. **ServiceTitan is turning into a quasi-ERP.** It has an internal sub-ledger with periods, AP automation with 3-way match
   (Jan 2026) and finance agents ([P](https://www.servicetitan.com/features/accounting),
   [P](https://www.servicetitan.com/press/servicetitan-introduces-ap-automation-and-expands-fintech-suite)). It is still "not a
   full GL replacement" and still batch-exports to QBO or Intacct. Its weak spots are where MeritBooks should win:
   - Membership deferred revenue doesn't flow through the GL ([P](https://help.servicetitan.com/docs/grow-recurring-revenue-with-memberships)).
   - Labor cost uses a burden-rate estimate that "will almost never match to the penny" with payroll ([P](https://help.servicetitan.com/docs/payroll-features)).
   - There is no automatic card surcharge ([P](https://help.servicetitan.com/docs/add-a-default-task-for-credit-card-fees-in-servicetitan.md)).
   - Sync failures ([P](https://help.servicetitan.com/docs/not-seeing-an-invoice-exported-to-quickbooks-online.md)).
6. **Table stakes in 2026:**
   - An **MCP server** (NetSuite, Acumatica, Business Central, Digits, Puzzle, Cube, Datarails, Check all ship one).
   - **AI-drafted flux** and close agents.
   - AP agents that capture, code and match.
   - W-9 and reconciliation agents (BILL).
   - Policy agents (Ramp).
   - Collections agents (Tesorio, Ramp Receivables, Simpro Fast Cash).

   MeritBooks has the architecture (propose → approve → deterministic post, decision log, autonomy dial) but is missing several
   of these *surfaces*, plus the scheduler that drives them.
7. **Matrix result (§2, 236 capabilities):** MeritBooks is **LIVE on 78, PARTIAL on 58, PLANNED on 61, MISSING on 38** (not in 04 at all), and **RETIRED in Books on 1** (in-app crew time).
   - The MISSING items cluster in five places:
     - Trades and field finance objects: service agreements, commissions, floor plan, warranty, allowances, request-for-claim, van stock.
     - Payment rails (mailed check, virtual card, instant).
     - Tax and compliance depth (TIN match, endorsements, exemption certificates, use tax).
     - Cross-entity bill pay.
     - Customer credit and disputes.
8. **Where MeritBooks is already ahead (keep marketing it):**
   - Borrower-side covenants, borrowing base and compliance certificates (no competitor found).
   - GL-native WIP with over/under billing (the field systems can't produce it).
   - Retainage.
   - Card **surcharge pass-through with an ACH-absorb toggle** (live in test, [R] `api/pay/[token]/intent/route.ts`). ServiceTitan lacks this.
   - DB-enforced period locks and segregation of duties.
   - Pay-time COI/W-9 holds.
   - Book-to-tax, ASC 740 and the tax package.
   - 12 deterministic exception detectors.
   - Native multi-entity at no per-entity upsell.
9. **Top additions (§6):**
   - scheduler
   - Ramp connection
   - approval enforcement
   - field-system ingestion with per-document tie-out
   - **service agreements/memberships with deferral**
   - **progress billing (SOV/G702/G703/draws) in Books**
   - **lien waivers + subcontractor compliance pack**
   - cross-entity bill pay + allocations
   - group close gate
   - watch rules
   - MCP
   - embedded payroll with labor distribution to jobs

---

## 1. Master competitor list (by category)

Columns:
- **Positioning** — one line.
- **Pricing model** — list price where public.
- **Why a customer buys it.**
- **Source.**

### 1-A. Ledger / ERP (incl. AI-native GLs)
| Product | Positioning | Pricing model | Why a customer buys it | Source |
|---|---|---|---|---|
| **QuickBooks Online** (Plus / Advanced) | Default US SMB GL, now with bundled AI agents (Accounting, Sales Tax, Payroll, Payments, Customer, Project Mgmt, Finance) | Per company file. 2025 list: Plus $115, Advanced $275 (+64% / +83% since 2020). After the Aug 2026 increase, ~$140 / ~$340 [3P]. Payroll, payments and time are extra | Every CPA knows it; huge app and bank ecosystem | [3P Woodard](https://report.woodard.com/articles/intuit-announces-2025-quickbooks-price-increases-fpwr), [3P beancount](https://beancount.io/blog/2026/08/25/quickbooks-online-price-hike-advanced-70-percent-guide), [3P agents](https://blog.insightfulaccountant.com/new-and-enhanced-ai-agents-across-the-intuit-platform) |
| **Intuit Enterprise Suite (IES)** + Construction edition | Intuit's mid-market multi-entity platform on the QBO stack | Quote. ~$7.8–8K/yr for 1 entity, $12–15K for 2–5 [3P]. Free Desktop migration | Multi-entity and consolidation without leaving the QuickBooks ecosystem | [3P erpresearch](https://erpresearch.com/en-us/intuit-enterprise-suite-pricing), [3P CPA PA](https://www.cpapracticeadvisor.com/2026/05/13/intuit-announces-several-enhancements-to-enterprise-suite/183362/) |
| **Xero** | Cloud SMB GL for accountants; JAX agent | $27 / $59 / $97 per month, unlimited users. US payroll via Gusto ($36 + $6/employee) | Simple, accountant-friendly, unlimited users | [P pricing](https://www.xero.com/us/pricing-plans/), [3P JAX](https://www.accountingtoday.com/news/xeros-jax-ai-gains-agentic-capacities) |
| **Sage 50** | Desktop/cloud-hybrid SMB, Windows | ~$124–271/mo by tier [3P] | Inventory and job cost on the desktop | [3P NerdWallet](https://www.nerdwallet.com/business/software/learn/sage-50cloud) |
| **Sage 100** (2026.0) | On-prem/hosted mid-market distribution and manufacturing | Partner quote | Mature inventory, sales order and job cost | [3P RKL](https://www.rklesolutions.com/blog/whats-new-in-sage-100-version-2026) |
| **Sage 300 CRE** (Timberline) | Incumbent on-prem construction accounting | Subscription by quote. ~$6.6K/yr up to $28–81K year one [3P] | The construction job-cost standard: AIA billing, retainage, subcontractor risk | [P](https://www.sage.com/us/sage-construction/sage-300-construction-and-real-estate), [3P ITQlick](https://www.itqlick.com/sage-300-construction-and-real-estate-formerly-sage-timberline-office/pricing) |
| **Sage Intacct** (+ Construction) | Cloud mid-market financials; multi-entity and dimensions; Copilot agents | Quote. Construction ~$400–800/user/mo + $40–100K implementation [3P] | Consolidation and dimensions; AICPA-preferred; construction WIP | [3P BPM R3 2026](https://www.bpm.com/insights/sage-intacct-2026-release-3/), [3P softabase](https://softabase.com/en/software/erp/sage-intacct-construction) |
| **Oracle NetSuite** | Largest cloud mid-market ERP; AI Connector (MCP); Intelligent Close Manager | Quote. Implementation $75–250K+ (competitor claims) | Breadth (ERP + CRM + inventory + OneWorld) and partner ecosystem | [P 2026.1](https://www.netsuite.com/portal/resource/articles/financial-management/netsuite-2026-1-features-new-ai-close-and-cash-management-ai-agents-for-planning-and-reconciliation-and-more.shtml), [P MCP PR](https://www.oracle.com/sg/news/announcement/sw25-netsuite-expands-suitecloud-platform-new-ai-innovation-2025-10-07) |
| **Acumatica** (+ Construction Ed.) | Cloud mid-market ERP; unlimited users; AI Studio + MCP (2026 R2) | Resource-based quote. ~$25–60K/yr [3P] | Unlimited users; construction and distribution depth | [P R2](https://www.acumatica.com/corporate-newsroom/press-releases/acumatica-2026-r2-release-with-embedded-ai/), [P Construction DS](https://www.acumatica.com/media/2026/03/Construction_Edition-DS-CON.pdf) |
| **Dynamics 365 Business Central** | Microsoft SMB/mid ERP; Payables/Sales/Expense agents; MCP | $80 Essentials / $110 Premium per user/mo [3P] | Microsoft 365 + Copilot; large VAR channel | [3P erpresearch](https://erpresearch.com/en-us/business-central-pricing-costs), [3P agents](https://letsdatascience.com/news/business-central-deploys-four-ai-agents-for-finance-fef9abda) |
| **Rillet** | AI-native ERP for SaaS/fintech leaving QBO/Xero; Aura agents | Quote; ~$10K CPA-led implementation | Real-time GL + ASC 606 + multi-entity at a fraction of NetSuite's cost | [P](https://rillet.com/llms.txt) |
| **Campfire** | AI-native ERP for Series B+ tech; built on Claude; Ember agents | Not public | Faster close with fewer accountants | [P](https://campfire.ai/llms.txt) |
| **DualEntry** | AI-native ERP targeting NetSuite/Intacct; "NextDay" migration | Quote tiers by entity count (≤3 / ≤20 / unlimited); implementation included | Free implementation; strong multi-entity (pitches one accountant running 20+ entities) | [P pricing](https://www.dualentry.com/pricing) |
| **Digits** | "Autonomous GL" for SMBs and firms | $65 / $100 / $250 **per entity** per month; API + MCP on all plans | Near-zero-touch bookkeeping; firm dashboard | [P](https://digits.com/pricing/) |
| **Puzzle** | AI-native GL for startups + firms; cash and accrual from one ledger | $30 / $72 / $120 / $360 per month | Cheap, real-time; "50% faster close or money back" | [P](https://puzzle.io/pricing) |

### 1-B. Close / controls overlays
| Product | Positioning | Pricing model | Why buy | Source |
|---|---|---|---|---|
| **BlackLine** | Enterprise close, reconciliation and intercompany; Verity AI | Quote | Audit-grade reconciliation and intercompany at scale | [P](https://www.blackline.com/blog/innovation-coming-to-verity-ai-at-beyondtheblack-london-2026/) |
| **FloQast** | Close management "by accountants"; Transform agents built from a past close | Quote; 3 packages; no per-user fees | Fast to deploy on NetSuite/Intacct; auditor-friendly | [P pricing](https://www.floqast.com/pricing), [P TakeControl 2026](https://www.floqast.com/press-releases/floqast-takecontrol-2026-ai-accounting-innovations) |
| **Numeric** | AI-first close; flux explanations linked to transactions | ~$30/user Essentials or quote [3P] | Auto-drafted flux; faster close | [3P TechCrunch](https://techcrunch.com/?p=2896647) |
| **Trintech** (Cadency / Adra) | "Governed autonomous finance"; 5 agents incl. Accruals Intelligence and Data Access | Quote | High-volume matching and reconciliation | [P](https://www.trintech.com/news/trintech-launches-three-new-ai-agents-to-advance-governed-autonomous-finance/) |

### 1-C. AP / AR / payments
| Product | Positioning | Pricing model | Why buy | Source |
|---|---|---|---|---|
| **BILL** (AP/AR) | SMB/mid AP/AR layer on QBO/Xero/ERP; W-9, Reconciliation, Transaction and Smart Response agents | $49 / $65 / $89 per user/mo + per-transaction fees (ACH $0.59, check $1.99, same-day ACH $11.99, instant 1%, 1099 $2.99). **Multi-entity only on Corporate+**; 3-way match on Enterprise | Default AP layer accountants put on QuickBooks | [P](https://www.bill.com:443/product/pricing), [P agents](https://www.bill.com/press-release/bill-launches-new-ai-agents) |
| **BILL Spend & Expense** (Divvy) | Free cards + expense | $0/user; interchange; ~1.5% cash back | Free cards and budgets | [P](https://www.bill.com:443/product/pricing) |
| **Tipalti** | Global AP and mass payouts; supplier tax compliance | AP from $99/mo + transaction fees; modules | 200+ countries, W-8/W-9, tax-ID validation, multi-entity | [P](https://tipalti.com/pricing/) |
| **Melio** (Xero) | Simple SMB bill pay, also embedded at banks | Free–$80/mo; card 2.9%, check $1.50 | Easiest ACH/card/check pay from QBO/Xero | [P](https://meliopayments.com/llm-info/) |
| **AvidXchange** (Corpay/TPG) | Mid-market AP + supplier network; strong in RE/construction | Quote by volume | Vertical ERP integrations, **lien-waiver management**, rebates | [P](https://www.avidxchange.com/press-releases/avidxchange-unveils-new-ai-agents-to-elevate-accounts-payable-processes/) |
| **Stampli** | AP on any ERP; "Billy" AI employee for procure-to-pay | Quote | Fast deployment; approvals stay in invoice conversations | [P](https://www.stampli.com/resources/ai-agents-in-finance/) |
| **Corpay** | Payments; AP turned into virtual-card rebate revenue | Rebate-led (1–1.5%; average client ~$43K/yr) | Rebate revenue + managed vendor enrollment + bank-change verification | [P](https://www.corpay.com/resources/blog/virtual-card-rebates) |
| **Plooto** | CA/US SMB AP/AR payments | ~$9–59/mo + $0.50/payment [3P] | Cheap combined payables and receivables | [3P](https://frontdeskreview.com/software/ap-automation/plooto/) |
| **Versapay** | Collaborative AR portal with line-item disputes | Quote | Fewer disputes; customer self-service | [3P Gartner](https://www.gartner.com/reviews/market/invoice-to-cash-applications/vendor/versapay/product/versapay-collaborative-ar) |
| **Upflow** | AR collections automation | Tiers by ARR; quote | Automated dunning + payment portal | [3P](https://erpresearch.com/erp-add-ons/ar-collections/upflow/pricing) |
| **Tesorio** | Collections + cash-forecast agents | Quote; median ~$17K/yr | Invoice-level payment-date prediction | [P](https://tesorio.com/get-started), [3P Vendr](https://www.vendr.com/marketplace/tesorio) |
| **HighRadius** | Enterprise autonomous order-to-cash, AP and treasury; 180+ agents | Outcome-based | Large-enterprise credit, deductions and cash application | [3P BusinessWire](https://www.businesswire.com/news/home/20250226984748/en/HighRadius-Announces-a-2027-Goal-of-Releasing-a-Fully-Autonomous-Finance-Platform-at-Radiance) |
| **Kolleno** | AI AR / credit control (not FP&A) | ~$1.1–1.6K/mo [3P, low confidence] | Lower DSO | [3P](https://www.spendbase.co/?p=37843) |

### 1-D. Spend / expense / travel
| Product | Positioning | Pricing model | Why buy | Source |
|---|---|---|---|---|
| **Ramp** | AI-first finance-ops platform: card, expense, travel, AP, AR (Sep 2026), procurement, treasury, accounting agents; **Ramp for Construction** | Free; Plus $15/user + platform fee; Enterprise quote. Same-day ACH $10, wire $15 | Free card + AI that ends coding and receipt chasing | [P pricing](https://ramp.com/pricing), [P releases](https://ramp.com/product-releases), [P construction](https://ramp.com/blog/new-on-ramp-july-edition-26) |
| **Brex** | Global card, expense, travel, bill pay | Essentials $0; Premium $12/user; Enterprise quote [3P] | Global entities and local cards | [3P](https://costbench.com/software/expense-management/brex) |
| **SAP Concur** | Legacy enterprise travel & expense (T&E) standard; Joule copilot [U] | Custom; heavy implementation; annual escalators | Enterprise travel content, global compliance | [3P](https://costbench.com/compare/brex-vs-sap-concur/) |
| **Expensify** | SMB receipt scanning, chat-based | Collect $5 / Control $9 per user [3P] | SmartScan needs no training | [3P](https://costbench.com/compare/brex-vs-expensify/) |
| **Navan** | Travel-first T&E with card | Travel free; expense ~$15/user [3P] | Travel inventory + policy | [3P](https://costbench.com/compare/brex-vs-navan/) |
| **Emburse** (Certify / Chrome River / Tallie) | Expense roll-up from SMB to enterprise | Custom | Configurable expense + AP | [3P](https://costbench.com/software/expense-management/certify/) |
| **Airbase** (Paylocity) | Mid-market spend + guided procurement inside HCM [U] | Custom | One approval engine across cards, bills, reimbursements | [3P](https://costbench.com/software/expense-management/airbase-expense/) |
| **Mercury** | Startup/SMB banking with bill pay, cards, treasury [U] | Free core; paid tiers [U] | Banking + bill pay + yield in one app | [U] |
| **Rho** | Banking + cards + AP + treasury [U] | Free platform; interchange/treasury [U] | Bank + AP + card with no software fee | [U] |

### 1-E. FP&A / reporting
| Product | Positioning | Pricing model | Why buy | Source |
|---|---|---|---|---|
| **Jirav** | Driver-based FP&A + workforce planning for SMBs and CFO firms | $50–150/mo firm tiers; business $10–15K/yr [3P] | Driver model + headcount per client. **Weak consolidation: one source system, same FYE and currency** | [P help](https://help.jirav.com/actuals/integration-capabilities) |
| **Mosaic → Bob Finance** (HiBob) | FP&A folded into HCM (acquired Feb 2025) | Quote | HR + finance planning on one employee dataset | [P HiBob](https://www.hibob.com/news/hibob-acquires-financial-planning-and-analysis-platform-mosaic-expanding-capabilities-to-empower-people-first-cfos/) |
| **Runway → cfo.ai** ("Ari") | Agentic AI CFO in Slack (Sept 2026 rebrand) | $295 / $1,000/mo / Enterprise [3P] | Always-on finance brain; alerts plus root cause | [3P SiliconANGLE](https://siliconangle.com/2026/09/10/exclusive-ai-finance-cfo-ai-launches-an-agentic-cfo-for-business-founders/) |
| **Cube** | Spreadsheet-native FP&A; MCP server | Quote; ~$15–80K/yr [3P] | Keep Excel with a governed data layer | [3P](https://erpresearch.com/erp-add-ons/fpa-planning/cube-software) |
| **Datarails** | Excel-native FP&A → "FinanceOS" MCP; Spend (Oct 2026) | $35–80K/yr mid-market [P] | Consolidates messy Excel + ERP; board-ready output from agents | [P](https://www.datarails.com/datarails-cost-and-features/), [3P CPA PA](https://www.cpapracticeadvisor.com/2026/10/16/datarails-rolls-out-end-to-end-spend-management-product/191837/) |
| **Planful** | Mid/upper CPM: plan, consolidate, close | Quote; Predict is an add-on | One governed suite | [3P](https://erpresearch.com/erp-add-ons/fpa-planning/planful/pricing) |
| **Vena** | Excel-native CPM; Planning/Reporting/Analytics/Scenario agents; MCP | Quote; median ~$34K/yr | Enterprise governance inside Excel | [P](https://www.venasolutions.com/vena-ai) |
| **Abacum** | AI-native mid-market FP&A | ~$15–75K/yr [3P] | Modern planning with business partners | [3P](https://frontdeskreview.com/software/fp-and-a-software/abacum/) |
| **Pigment** | Enterprise multidimensional planning with agents | ~$30–400K/yr [3P] | Connected planning at scale | [3P](https://www.cfoshortlist.com/reports/pigment-pricing) |
| **Fathom** | Reporting, 3-way forecasts, consolidation (300 entities), benchmarking | **$450/mo for 25 companies; Portfolio $67/mo for 100** | Cheap branded advisory packs + group consolidation | [P](https://www.fathomhq.com/pricing) |
| **Spotlight Reporting** | vCFO suite for advisors; Multi benchmarks up to 500 orgs | $329–995/mo by org count | Packaged vCFO deliverables | [P](https://www.spotlightreporting.com/pricing/us-advisor) |
| **Reach Reporting** | Report packs, 3-way forecasts, consolidation | $149 (1) to $550 (25 connections)/mo [3P] | Presentation-grade packs, cheap | [P](https://reachreporting.com/features) |
| **LivePlan** | Business plan + forecast + benchmarks for owners | $20 / $40/mo | Bankable plan cheaply | [3P Capterra](https://www.capterra.com/p/142049/LivePlan/pricing/) |
| **Float** | Cash-flow forecasting on Xero/QBO; multi-entity on Scale | $215–389/mo | Visual 13-week / 36-month cash with scenarios | [P](https://floatapp.com/pricing) |
| **Syft** (Xero) | Reporting + consolidation with **AI-suggested eliminations** | ~$23/mo; free on eligible Xero plans | Cheap deep consolidation + AI commentary | [P help](https://help.syftanalytics.com/en/articles/9018885-consolidations) |
| **Qvinci** | Multi-location/franchise aggregation into a standard chart of accounts (COA); benchmark rankings | Quote | Comparable unit P&Ls — **the closest analog to a trades roll-up** | [P](https://www.qvinci.com/franchising/) |
| **Joiin** | Multi-entity consolidation | AUD 360/mo + $4/entity | Fast group consolidation across Xero/QBO/Sage | [3P Xero apps](https://apps.xero.com/au/search/app/joiin) |
("DataRails" in the ask = Datarails.)

### 1-F. Practice / firm
| Product | Positioning | Pricing model | Why buy | Source |
|---|---|---|---|---|
| **Double** (= **Keeper**, renamed Oct 2025) | Ledger-integrated close for firms; file reviews, client questions, flux | ~$10 / $25 / $50 per client/mo [3P] | Run the close across hundreds of QBO/Xero files | [3P CPA PA rename](https://www.cpapracticeadvisor.com/2025/10/24/keeper-has-rebranded-to-double/171596/), [P](https://doublehq.com) |
| **Karbon** | Practice management + shared email; Kai AI coworker | $59–89/user/mo | Email triage + workflow + capacity | [P](https://karbonhq.com/pricing/) |
| **Canopy** | All-in-one practice management (tax-rooted); **Close Automation $10/client** | $74–149/user + add-ons | One tool for CRM, documents, portal, workflow, billing | [P](https://www.getcanopy.com/pricing/) |
| **Financial Cents** | Affordable workflow + client requests; **Month-End Close add-on $5/client** | $19–69/user | Cheap seats with built-in client task chasing | [P](https://financial-cents.com/?p=1593) |
| **TaxDome** | Portal-heavy practice management for tax firms | $800–1,200/seat/yr | Strongest client portal and mobile app | [P help](https://help.taxdome.com/article/1800-taxdome-pricing-plans-us-ca) |
| **Uku** | Recurring-work practice management | $19–88/member/mo | Recurring deadlines + automated billing | [3P Capterra](https://www.capterra.com.au/software/197626/uku) |
| **Ignition** | Proposals, engagement letters, billing; AI Price Insights | From ~$39/mo + Stripe fees | Signed, priced engagements with payment up front | [P](https://www.ignitionapp.com/pricing-packaging) |
| **Intuit Accountant Suite / QBOA** | Free firm hub for QBO clients + paid suite [U] | QBOA free; Suite [U] | Default for QBO-centric firms | [U]; partner context [3P](https://www.businesswire.com/news/home/20260127050650/en/Double-Named-a-Platinum-Partner-in-Intuits-App-Partner-Program-Defining-Ledger-Level-Close-Execution) |
| **Xero HQ** | Free partner console + Practice Manager / Workpapers [U] | Free + modules [U] | Default for Xero firms; Syft bundled | [P Syft offer](https://www.xero.com/campaign/syft-from-xero/) |

### 1-G. Payroll / HR / time / workforce
| Product | Positioning | Pricing model | Why buy | Source |
|---|---|---|---|---|
| **Gusto** | SMB payroll + benefits + HR | $49+$6 / $80+$12 / $180+$22 | Easy transparent payroll; project costing on Premium (only after payroll runs) | [P](https://gusto.com/product/pricing) |
| **Gusto Embedded** | Payroll API / React SDK / Flows; **GL report API by job or department**; multi-company Payroll Digests | Sales-led | White-label payroll in 4–6 weeks (Flows) | [P](https://embedded.gusto.com/product/payroll-api), [P GL API](https://docs.gusto.com/embedded-payroll/docs/retrieve-a-general-ledger-report) |
| **Check** | Pure-API payroll; powers Miter, Trayd (construction), Homebase, Housecall Pro; MCP server | Sales-led | Max flexibility; per-earning workplace and WA L&I codes; platform not liable for credit/fraud loss | [P](https://www.checkhq.com/platform/payroll), [P config](https://www.checkhq.com/configuration) |
| **ADP** (RUN / Workforce Now for Construction) | Incumbent; native certified payroll + union fringes in WFN | Quote | Scale + construction/union handling | [P](https://www.adp.com/who-we-serve/by-industry/construction.aspx) |
| **Paychex Flex** | Service-heavy SMB/mid payroll + PEO | Quote | Dedicated reps; job-costing add-on | [P](https://www.paychex.com/product-releases/november-2024) |
| **Paylocity** | Mid-market human capital management (HCM) incl. Airbase spend | Quote, per employee/mo | Modern all-in-one HCM | [P](https://www.paylocity.com/why-paylocity/compare/lists/adp-competitors/) |
| **Rippling** | Unified HR/IT/finance; multi-entity payroll; GL by project/entity | From $8/employee/mo + base | Multi-entity automation | [P](https://www.rippling.com/blog/payroll-software-enterprises-rfp-template) |
| **Deel** | Global employer of record (EOR) / contractors / US PEO | Contractors $49; EOR $599+ | Cross-border workers (low trades relevance) | [P](https://www.deel.com/pricing/) |
| **Justworks** | PEO-first | Payroll $8/employee + $50; PEO $79–124/employee | Large-group benefit rates | [P](https://www.justworks.com/pricing) |
| **QuickBooks Workforce / Time** (TSheets) | Intuit payroll + time with geofence/GPS | Time $20+$10/user; Workforce Elite $134+$17 | Already on QBO | [P](https://quickbooks.intuit.com/time-tracking/pricing/) |
| **Homebase** | Scheduling + time + payroll (on Check) | Free–$120/location + payroll $49+$6 | Cheap shift teams | [P](https://www.joinhomebase.com/pricing) |
| **ClockShark** | GPS crew time + job costing | $40+$9 / $60+$11 per user [3P] | Simple crew clock | [3P](https://www.clockshark.com/blog/best-time-clock-small-business) |
| **Workyard** | GPS-verified construction time with cost codes | From $6/user | Most precise field hours → payroll + job cost | [P](https://www.workyard.com/compare/certified-payroll-software) |
| **busybusy** | Construction time + **equipment hours** | Free; $9.99–14.99/user + $40 | Machine + labor hours | [P](https://busybusy.com/price/) |
| **Connecteam** | Deskless-team app; GPS clock, forms | $29–99/mo per 30 users | Cheap mobile clock + forms | [P](https://connecteam.com/pricing/) |
| *Construction payroll layer:* Miter, Trayd, Points North, LCPtracker | Certified payroll (WH-347), prevailing wage, union fringes; Miter/Trayd run on Check | Quote | The certified-payroll layer the embedded APIs don't provide | [P Check/Trayd](https://www.checkhq.com/resources/blog/deep-dive-solving-complexities-in-construction-payroll-with-trayd) |

### 1-H. Tax / vendor compliance — **all [U] unless noted; verify**
| Product | Positioning | Pricing model | Why buy |
|---|---|---|---|
| **Avalara** (AvaTax, Returns, exemption cert mgmt (ECM), **1099 & W-9 = former Track1099**) | Largest US indirect-tax suite | Quote by volume. BBB complaints of 2×–9× renewals ([P BBB](https://www.bbb.org/us/wa/seattle/profile/computer-software-developers/avalara-1296-22018273/customer-reviews)) | Rooftop rates; returns; exemption certificates; consumer use tax on AP |
| **Anrok** | Sales tax/VAT for SaaS | Free nexus tier; revenue-scaled | Nexus monitoring (poor fit for trades) |
| **TaxJar** (Stripe) | E-commerce sales tax | Order-volume tiers + AutoFile | Simple calc + AutoFile |
| **Track1099** | See Avalara 1099 & W-9 | Per form | 1099 e-file, state, TIN match, W-9 collection |
| **Tax1099** (Zenwork) | IRS-authorized e-file for 1099/W-2/94x | Per form | High-volume multi-client 1099 + state + real-time TIN match |
| **Zenwork** Compliance Cloud | Vendor onboarding compliance | Quote | W-9/W-8, TIN, OFAC, address validation |
| **myCOI** (+ illumend AI) | COI tracking for RE / construction / franchise | Quote / self-serve | AI + human ACORD 25 and endorsement review vs requirements |
| **Certificial** | Carrier/agent-connected "Smart COI" | Requester subscription | **Continuous live-policy monitoring** (cancellation alerts) |
| **TrustLayer** | COI + document verification with broker workflow | Tiered | Endorsement extraction (additional insured, waiver of subrogation, primary & non-contributory) |
| **Billy** | Construction COI compliance | Quote | Construction requirement sets; flags subs for AP payment hold |
| **Jones** (getjones.com) | COI compliance for construction/RE | Per vendor | Fast endorsement-level verification |

### 1-I. Field / industry systems (finance features in §5)
| Product | Positioning | Pricing model | Why buy | Source |
|---|---|---|---|---|
| **ServiceTitan** | Trades "agentic OS"; internal sub-ledger; AP automation; memberships; performance pay; financing | Quote per tech; ~$245–500/tech/mo + $5–50K implementation [3P] | End-to-end residential/commercial service ops | [P accounting](https://www.servicetitan.com/features/accounting), [3P pricing](https://www.fieldproxy.ai/fsm-software-pricing/servicetitan) |
| **Buildertrend** | Residential builder/remodeler project management (PM); budgets, POs, draws, selections, payments, financing | ~$199–1,099/mo flat, unlimited users [3P] | Builder PM + client portal | [P invoices](https://buildertrend.com/help-article/invoice-overview/) |
| **INNERGY** | Cabinet/millwork ERP: estimating → BOM → purchasing → job cost; AIA billing | Quote by role | Shop-floor ERP for custom woodwork | [P](https://www.innergy.com/overview) |
| **Simpro** | Trade-contractor field service + projects; retentions; Maintenance Planner; Fast Cash AI | Quote per user; long lock-ins [3P] | Projects + service + assets for commercial trades | [P retention](https://helpguide.simprogroup.com/Content/Service-and-Enterprise/Retention.htm), [P Fast Cash](https://www.simprogroup.com/features/fast-cash) |
| **RFMS** (Cyncly) | Flooring retailer/contractor ERP with its own GL/journal package | Quote by module | Measure → order → roll inventory → installer pay | [P GL](https://rfms.support.cyncly.com/hc/en-us/articles/50200023050129), [P API](https://rfms.com/solutions/api) (features [U]) |
| **c-Systems Infinity** | Outdoor power equipment (OPE) / ag dealer management system (DMS) with integrated GL | Quote | Whole goods, parts, service, warranty, floor plan | [P KB](https://infinity.csystemssoftware.com/knowledgeBase/14605310) (features [U]) |
| **Procore** | Enterprise construction platform; Procore Pay; invoice management | Annual construction volume; ~$10K+ to $50–150K/yr [3P] | General contractor (GC) / owner collaboration; subcontractor pay apps; lien waivers | [3P Projul](https://projul.com/blog/construction-software-pricing-guide-2026/) (features [U]) |
| **JobTread** | Small/mid builder management | Flat + per user [U] | Cost-code estimating → budget → POs → invoices | [U] |
| **Jobber** | SMB home-services field service management (FSM) | $29–399/mo; payments 2.9%+30¢ / ACH 1% | Quotes → jobs → invoices → payments; Wisetack financing | [3P fieldproxy](https://www.fieldproxy.ai/fsm-software-pricing/jobber) |
| **Housecall Pro** | Residential home-services FSM; payroll on Check | $59–299/mo | Polished mobile app; Wisetack | [3P fieldproxy](https://www.fieldproxy.ai/fsm-software-pricing/housecall-pro) |
| **FieldEdge** | HVAC/plumbing service; deep QuickBooks Desktop sync | Quote per office/tech user | QuickBooks-centric service shops | [3P fieldproxy](https://www.fieldproxy.ai/fsm-software-pricing/fieldedge) |

---

## 2. Feature matrix (236 capabilities)

**Category codes** (columns: where the capability is commonly sold):

| Code | Category |
|---|---|
| LED | ledger/ERP |
| AIG | AI-native GL |
| CLS | close/controls |
| AP | AP/payments |
| AR | AR/collections |
| SPD | spend/expense |
| FPA | FP&A/reporting |
| PRC | practice/firm |
| WRK | payroll/time |
| TAX | tax/compliance |
| FLD | field/industry |

**MeritBooks status** comes from 04 (ID in brackets). STUB is folded into PARTIAL. **MISSING** means not in 04 at all.

**Priority** [J]:

| Priority | Meaning |
|---|---|
| **Must** | Table stakes for replacing QuickBooks plus the bolt-ons for this segment |
| **Should** | Expected within 12 months |
| **Diff** | Differentiator: few or no competitors do it well, so it wins deals |
| **Partner** | Integrate, don't build |
| **Later** | Low priority |

### 2.1 General ledger, multi-entity & consolidation
| # | Capability | Categories | Who has it (exemplars) | MeritBooks | Priority |
|---|---|---|---|---|---|
| 1 | Double-entry GL, balance enforced in the database | LED AIG | all | LIVE [GL-01] | Must |
| 2 | Dimensions on every line (client/dept/class/item/job) **with no usage caps** | LED AIG | Intacct, NetSuite; QBO Plus caps classes+locations at 40 combined ([3P](https://insightfulaccountant.com/accounting-tech/general-ledger/quickbooks-online-usage-limits-did-you-know)) | LIVE [DIM-01] | Must |
| 3 | Required-dimension rules per account/entity | LED | Intacct, NetSuite, Acumatica | LIVE [DIM-02] | Must |
| 4 | Many entities in one tenant, one login, shared COA template | LED AIG | IES, Intacct, NetSuite, Acumatica, Rillet, Campfire, DualEntry | LIVE (client model) | Must |
| 5 | Intercompany due-to/due-from auto-created on cross-entity transactions | LED AIG | IES (May 2026), Intacct, NetSuite, DualEntry, Campfire | LIVE [CON-05] | Must |
| 6 | **Cross-entity bill pay** (pay entity B's bill from entity A's bank; intercompany JEs automatic) | LED | IES ([3P](https://www.cpapracticeadvisor.com/2026/05/13/intuit-announces-several-enhancements-to-enterprise-suite/183362/)) | MISSING | Must |
| 7 | Consolidation with eliminations, NCI, FULL/EQUITY | LED AIG FPA | IES, Intacct, NetSuite, Rillet, Campfire, Fathom, Syft, Joiin | LIVE [CON-01] | Must |
| 8 | FX translation (ASC 830) in consolidation | LED FPA | NetSuite, Campfire, Fathom, Syft | LIVE [CON-03] | Should |
| 9 | Multi-level ownership trees (fund → SPE → company) | LED | IES hierarchies, Intacct, Fathom | PARTIAL [CON-08] | Must |
| 10 | Named consolidation / combined groups | FPA | Fathom, Joiin, Reach, Spotlight | PLANNED [CON-07] | Must |
| 11 | **AI-suggested intercompany elimination matches with a score** | FPA | Syft ([P](https://help.syftanalytics.com/en/articles/9018885-consolidations)) | PARTIAL (EC-3 detects mismatches only) [CON-04] | Diff |
| 12 | Elimination lines with drill-down | LED CLS | BlackLine, Campfire, Intacct | PARTIAL [CON-02] | Should |
| 13 | Group-level top-side adjustments | LED CLS | Intacct, NetSuite, BlackLine | PLANNED [CON-09] | Should |
| 14 | **Allocation rules** (e.g. management fee by revenue %, shared insurance by headcount) | LED AIG | DualEntry Ultra, NetSuite Allocation Trace, Intacct, Campfire | PLANNED [AR-20] (must not reuse the retired overhead engine) | Must |
| 15 | Recurring / reversing JEs | LED | all | LIVE [GL-09] | Must |
| 16 | JE upload from spreadsheet | LED | IES (May 2026), DualEntry, NetSuite | PLANNED [GL-10] | Should |
| 17 | Natural-language JE composer | AIG | Digits, DualEntry Copilot (drafts, doesn't post) | PARTIAL [GL-07] | Should |
| 18 | Period 13 / adjusting period | LED | Sage, NetSuite, Acumatica [U] | PLANNED [GL-12] | Should |
| 19 | Statistical accounts (headcount, sq ft, techs, trucks) | LED | Intacct, NetSuite, BC [U] | PLANNED [GL-13] | Should |
| 20 | Cash / accrual / tax basis from one ledger | LED AIG | Puzzle ([P](https://puzzle.io/pricing)) | LIVE overlay [GL-14] | Should |
| 21 | Full parallel multi-book (GAAP/tax/IFRS) | LED | NetSuite, Acumatica; DualEntry "soon" | PLANNED [GL-15] | Later |
| 22 | Transactional multi-currency | LED AIG | Xero (Established), NetSuite, Campfire 180+ | PLANNED [GL-19] | Later |
| 23 | Field-level audit trail + "created/modified by AI" flags | LED AIG | BC agents ([3P](https://letsdatascience.com/news/business-central-deploys-four-ai-agents-for-finance-fef9abda)), all ERPs | LIVE [GL-17, CTRL-08] | Must |
| 24 | Closed-period edit → approval-queued proposal | AIG | Digits (MCP writes protected by locked periods, [P](https://digits.com/pricing/)) | PLANNED [GL-20] | Diff |
| 25 | Full tenant data export / backup ("leave anytime") | LED | Complaint: QBO has "no facility to back up and restore" ([P forum](https://www.accountingweb.co.uk/any-answers/quickbooks-qbo-unilaterally-unsubscribing)) | PARTIAL [ONB-12] | Diff |
| 26 | COA approval workflow; control-account protection | LED | Intacct, NetSuite | LIVE [GL-04, GL-05] | Must |
| 27 | Year-end close to retained earnings | LED | all | LIVE [GL-11] | Must |

### 2.2 Close, reconciliation & controls
| # | Capability | Categories | Who has it | MeritBooks | Priority |
|---|---|---|---|---|---|
| 28 | Close checklist as an ordered task graph with due dates | CLS PRC | FloQast, Numeric, Intacct Close Assistant, Rillet, Double, Canopy | LIVE [CLS-02]; due dates PARTIAL [CLS-04] | Must |
| 29 | Auto-verified close checks with a blocking hard-close gate | CLS AIG | NetSuite Intelligent Close Manager (ICM), Digits Agentic Close | LIVE [CLS-02, REC-09] | Must |
| 30 | Close status across all entities / clients | CLS PRC | Double Close Page, Digits firm close tracker | LIVE [CLS-03] | Must |
| 31 | **Group close gate + auto post-close package** | CLS | NetSuite ICM, Sage Close Analytics | PARTIAL [CLS-09] | Must |
| 32 | Bank reconciliation with auto-match | LED | all | LIVE [REC-01/02] | Must |
| 33 | Reconcile from a PDF statement (AI compares statement to ledger) | LED CLS | QBO Accounting Agent, BlackLine Verity Prepare | PARTIAL [BNK-10] | Should |
| 34 | Reconciliation evidence pinned; "lines broke a reconciled account" alert | CLS AIG | Digits, Numeric, BlackLine | PLANNED [REC-08] | Should |
| 35 | Card and loan account reconciliation | LED | all | PARTIAL [REC-07] | Must |
| 36 | Subledger ↔ GL tie-outs (AR, AP, inventory, payroll, prepaid) | CLS | Intacct Subledger Reconciliation Assistant ([3P](https://www.cpapracticeadvisor.com/2025/05/14/sage-unveils-new-ai-driven-tools-and-innovations-for-sage-intacct/161027/)), FloQast | LIVE [CLS-13] | Must |
| 37 | Balance-sheet working papers with preparer/reviewer sign-off | CLS | FloQast, BlackLine, Numeric | PLANNED [CLS-07] | Must |
| 38 | Reviewer approve/return-with-note loop | CLS PRC | FloQast, Double | PLANNED [CLS-08] | Must |
| 39 | **AI-drafted flux explanations linked to transactions** | CLS AIG | Numeric, FloQast, Rillet, Campfire, Trintech, Double | PARTIAL [FPA-10] (deterministic drivers; AI wording dark) | Must |
| 40 | Accrual suggestions + tracking their own accuracy | CLS | Trintech Accruals Intelligence ([P](https://www.trintech.com/news/trintech-launches-three-new-ai-agents-to-advance-governed-autonomous-finance/)), Campfire, Rillet | PARTIAL (missed-accrual detector only) | Should |
| 41 | Prepaid / amortization automation | CLS AIG | Intacct R3, Rillet, Campfire, FloQast | LIVE [FA-08] | Must |
| 42 | JE risk review before approval (risk score + suggested fix) | CLS | FloQast AI Assistant, BlackLine | PARTIAL [GL-18, EC-10] | Should |
| 43 | GL / AP anomaly detection | LED CLS | Intacct, NetSuite, Acumatica, DualEntry | LIVE [CTRL-01] | Must |
| 44 | Vendor master change near payment detection | LED AP | NetSuite 2026.1, Intacct R3 | LIVE [PAY-04] | Must |
| 45 | **Approval enforcement on every doc; one policy for people AND agents** | CLS AIG | Rillet, BC, Light | PARTIAL [CTRL-04, GL-08] | Must |
| 46 | Segregation of duties enforced in the database | CLS | Campfire (1,200 permissions), BlackLine | LIVE [PAY-03, PRL-05] | Must |
| 47 | SOX / control testing evidence | CLS | FloQast Risk & Compliance, BlackLine | PARTIAL [CTRL-05/06] | Should |
| 48 | AI governance module (COSO GenAI) / agents that audit agents | CLS | FloQast TakeControl 2026 ([P](https://www.floqast.com/press-releases/floqast-takecontrol-2026-ai-accounting-innovations)) | PLANNED [CTRL-12] | Diff |
| 49 | Plain-English custom checks → deterministic rules | CLS AIG | Digits, Rillet Aura Flow | PLANNED [CTRL-10] | Diff |
| 50 | External auditor access + PBC lists | CLS PRC | Karbon, TaxDome, Double | LIVE [CTRL-13] | Must |
| 51 | Close-readiness score / continuous close | CLS | Digits, NetSuite ICM | PARTIAL [CLS-11] | Should |
| 52 | "Data Access" agent for systems without APIs | CLS | Trintech | MISSING (07 bridge lane via QBO is the stand-in) | Should |

### 2.3 AI & agent platform
| # | Capability | Categories | Who has it | MeritBooks | Priority |
|---|---|---|---|---|---|
| 53 | Learning bank categorization (rules → vendor memory → AI) | LED AIG | all | LIVE [BNK-03] | Must |
| 54 | Per-feature autonomy dial + stop-all switch | AIG | BC "stop all agents" | LIVE [CTRL-09] | Must |
| 55 | AI decision log (inputs, confidence, rejected alternative) | AIG CLS | Trintech, BlackLine "show your work" | LIVE [CTRL-08] | Must |
| 56 | Natural-language Q&A over the live ledger that shows its work | LED AIG FPA | Intacct Finance Intelligence Agent, Xero JAX, Rillet Aura, Campfire, Puzzle | LIVE [AI-04/05] (heuristic without AI) | Must |
| 57 | **MCP server (read)** | LED AIG FPA WRK | NetSuite, Acumatica R2, BC, Digits, Puzzle, Cube, Datarails, Vena, Check | PLANNED [INT-12] | Must |
| 58 | MCP writes as proposals, blocked by locked periods | AIG | Digits | PLANNED [INT-12] | Diff |
| 59 | Build agents from plain text / from a completed close | AIG CLS | Acumatica AI Studio, BC Agent Designer, FloQast Transform, Rillet Aura Flow | PARTIAL [CLS-06, AI-07] | Diff |
| 60 | Partner agent marketplace | LED | Intacct AI Agent Marketplace | MISSING | Later |
| 61 | **Watch rules & proactive alerts** (Slack/Teams/email/SMS) | FPA AIG | cfo.ai Ari, Fathom KPI alerts, Nume | PLANNED [CTRL-11] | Must |
| 62 | AI CFO agent: monitors KPIs, investigates causes | FPA AIG | cfo.ai Ari, QBO Finance Agent, Digits | PLANNED [AI-11] | Diff |
| 63 | Shared business context every agent reads | AIG FPA | Vena Omega, Nume | PLANNED [AI-10] | Should |
| 64 | AI regression/eval suite per release | AIG | Nume, Digits | PLANNED [CTRL-16] | Should |
| 65 | Voice agent (collections calls / "what's cash across the group?") | AR AIG | BlackLine Verity Collect (voice collections) | PLANNED [AI-13] | Diff |
| 66 | Drop-and-parse any document (bills, leases, loans, COIs, payroll) | LED AIG | NetSuite/Intacct Document AI | PARTIAL [AI-02] (review UIs live; AI dark) | Must |
| 67 | Agents output board-ready PPT/PDF/XLSX | FPA | Datarails agents ([P](https://www.datarails.com/blog/datarails-raises-70m-series-c-ai-for-cfos/)) | PARTIAL [FPA-14] | Should |
| 68 | Peer / industry benchmarking from pooled transaction data | LED FPA | IES, Xero, Fathom, Spotlight Multi, Qvinci, LivePlan | PLANNED [FPA-19] | Diff (trades-specific) |
| 69 | "AI paused" honesty + deterministic fallback | AIG | — (no competitor advertises it) | LIVE [AI-15] | Diff |
| 70 | AI usage/cost per tenant/feature | AIG | BC usage-based agent billing | PARTIAL [AI-14] | Should |

### 2.4 AP & procure-to-pay
| # | Capability | Categories | Who has it | MeritBooks | Priority |
|---|---|---|---|---|---|
| 71 | Bills + AP subledger | LED AP | all | LIVE [AP-01] | Must |
| 72 | **AI invoice capture with line-level GL/job coding** | AP LED FLD | BILL, Tipalti, Stampli, AvidXchange, Ramp AP agents, BC Payables Agent, ServiceTitan Payables Inbox | PARTIAL [AP-02] | Must |
| 73 | Per-entity AP email inbox | AP | BC, BILL, ServiceTitan | PARTIAL [AP-03] (no mail provider) | Must |
| 74 | Approval routing by amount/dept/vendor/job | AP | all AP tools | LIVE [AP-06] (enforcement PARTIAL) | Must |
| 75 | Approval-likelihood prediction | AP | AvidXchange AI Approval Agent ([P](https://www.avidxchange.com/press-releases/avidxchange-unveils-new-ai-agents-to-elevate-accounts-payable-processes/)) | MISSING | Later |
| 76 | PO + goods receipt + 3-way match with tolerances | AP LED FLD | BILL (Enterprise only), Tipalti, Ramp, ServiceTitan, Acumatica | LIVE [AP-11] | Must |
| 77 | Purchase requests / intake-to-pay with encumbrance | AP SPD | Ramp Procurement, Tipalti Purchase Request Agent, BILL | PLANNED [AP-12] | Should |
| 78 | Recurring bills | AP | BILL, QBO | PLANNED [AP-09] | Should |
| 79 | Vendor credits / debit memos (incl. installer back-charges) | AP | all | PARTIAL [AP-10] | Must |
| 80 | Duplicate / anomalous bill detection | AP | Intacct R3, Tipalti, Ramp | LIVE [AP-05] | Must |
| 81 | Vendor-reply agent ("where's my payment?") | AP | BILL Smart Response (beta) | PLANNED [AP-17] | Should |
| 82 | Vendor self-service portal (W-9/COI/banking) | AP TAX | Tipalti, AvidXchange, Melio | LIVE [VND-06] | Must |
| 83 | Vendor invoice-status lookup in the portal | AP | AvidXchange supplier hub | MISSING | Should |
| 84 | **W-9 agent: request, pre-validate, IRS TIN match** | AP TAX | BILL W-9 Agent, Tipalti (62 countries), Tax1099 [U] | PARTIAL (parse yes; no IRS TIN match) | Must |
| 85 | Vendor bank-change verification that **blocks payment** until confirmed out-of-band | AP | BILL emails the vendor but doesn't block ([P](https://vendorpayhelp.bill.com/hc/en-us/articles/360056648731)); Corpay managed service | PARTIAL [PAY-04] (screens at release) | Diff |
| 86 | Early-pay discount capture / dynamic discounting | AP | AvidXchange, Corpay [U] | PLANNED [AP-13] | Should |
| 87 | Approval delegation (out of office) | AP | BILL, Ramp [U] | PLANNED [AP-07] | Should |
| 88 | Contract extraction + vendor price-increase alerts | AP SPD | Ramp vendor management ([P](https://ramp.com/pricing)) | PLANNED [AI-11] | Should |
| 89 | PO accruals (received, not billed) at month end | AP CLS | Ramp PO accruals (Sep 2026) | PARTIAL (detector only) | Should |
| 90 | **Lien waivers (conditional/unconditional) gated to payment** | AP FLD | Procore Pay [U], Buildertrend ([P](https://buildertrend.com/help-article/advanced-purchase-orders-bills-overview/)), AvidXchange, Ramp for Construction, Acumatica | PLANNED [REV-17] (exists in Projects: [R] mig `1005_proj_operational.sql` `PRECONDITION_LIEN_WAIVER`) | Must |
| 91 | COI / W-9 compliance hold at pay time | AP TAX | Ramp for Construction, Billy [U] | LIVE [AP-16, VND-03] | Diff |
| 92 | Job / cost-code coding on bills and card spend | AP FLD | ServiceTitan, Buildertrend, Ramp for Construction | LIVE (dimensions + job) | Must |
| 93 | Subcontractor pay applications against commitment SOV with retainage per line | AP FLD | Procore Invoice Management [U], Acumatica, Intacct R3 tiered retainage | PLANNED [REV-18] | Should |
| 94 | Consumer use-tax accrual on untaxed material purchases | AP TAX | Avalara [U] | MISSING | Should |
| 95 | Managed vendor enrollment / AP-as-a-service | AP | AvidXchange, Corpay | MISSING | Partner |
| 96 | Pay-when-paid / pay-if-paid linkage (sub payable released when owner pays) | AP FLD | IES (planned, per job posting) | MISSING | Diff |

### 2.5 Payments & treasury
| # | Capability | Categories | Who has it | MeritBooks | Priority |
|---|---|---|---|---|---|
| 97 | Pay / check runs with preparer ≠ approver ≠ releaser | AP | BILL, Melio | LIVE [PAY-01, PAY-03] | Must |
| 98 | Check printing on stock with MICR | LED AP | QBO, Sage | PLANNED [PAY-05] | Must |
| 99 | Mailed-check service | AP | BILL $1.99, Melio $1.50, Buildertrend $1.49 ([P](https://badge.buildertrend.com/financial-tools/payments/)) | MISSING | Partner |
| 100 | ACH origination (standard / same-day) via licensed provider | AP | BILL, Ramp, Melio, Plooto | PARTIAL stub [PAY-09] | Must |
| 101 | Instant / RTP payments | AP | BILL (1%) | MISSING | Later |
| 102 | Virtual-card AP with rebate share | AP | Corpay (1–1.5%), AvidXchange, BILL, Tipalti Card | PLANNED [PAY-11] | Partner |
| 103 | International / FX payouts | AP | Tipalti (200+ countries), BILL, Melio | MISSING | Later |
| 104 | Positive pay (issue file + exception decisioning) | AP | banks | PARTIAL [PAY-07] | Must |
| 105 | NACHA file export | AP | — | PARTIAL [PAY-08] | Should |
| 106 | Scheduled payments | AP | all | PLANNED [PAY-12] | Must |
| 107 | Payment-run fraud screen (new payee, BEC, duplicate) | AP | Ramp, Tipalti, NetSuite | LIVE [PAY-04] | Must |
| 108 | OFAC / sanctions screening on payees | AP TAX | Tipalti, Zenwork [U] | MISSING | Should |
| 109 | Cash position across entities with min-cash status | FPA SPD | Ramp Treasury, Float, NetSuite Cash 360 | LIVE [CASH-01] | Must |
| 110 | 13-week direct cash forecast | FPA AR | Float, Tesorio, NetSuite Cash 360 | LIVE [CASH-04] | Must |
| 111 | Forecast layers (actual / committed / AI) + invoice-level pay-date prediction | FPA AR | Tesorio, Campfire | PARTIAL [CASH-05] | Should |
| 112 | Forecast-vs-actual accuracy tracking | FPA | Trintech (accruals), Tesorio | PLANNED [CASH-07] | Should |
| 113 | Min-cash alerts + intercompany sweep recommendations | FPA | NetSuite [U] | PLANNED [CASH-03, CASH-11] | Diff |
| 114 | Renewals & obligations calendar | FPA | — | LIVE [CASH-08] | Diff |
| 115 | Subscription creep detection | SPD | Ramp vendor management | LIVE [CASH-09] | Should |
| 116 | Treasury yield / sweep | SPD | Ramp (2% checking), Mercury, Rho | MISSING | Partner |
| 117 | In-product bank accounts | SPD | Mercury, Rho, Ramp Checking | MISSING | Not recommended (regulated) |

### 2.6 AR, billing, revenue & collections
| # | Capability | Categories | Who has it | MeritBooks | Priority |
|---|---|---|---|---|---|
| 118 | Invoices with branded PDFs per entity | LED AR | all | LIVE [AR-01/02] | Must |
| 119 | Recurring invoices | LED AR | all | LIVE [AR-04] | Must |
| 120 | Estimates → invoice | LED FLD | all | LIVE [AR-06] | Must |
| 121 | Customer deposits / retainers | LED FLD | Buildertrend, ServiceTitan | LIVE [AR-07] | Must |
| 122 | Online pay by card/ACH → PAID → GL | AR | all | LIVE test [AR-10] | Must |
| 123 | **Card surcharge pass-through with ACH-absorb option, most-specific-wins** | AR FLD | Buildertrend one-click pass-through; **ServiceTitan has no auto surcharge** ([P](https://help.servicetitan.com/docs/add-a-default-task-for-credit-card-fees-in-servicetitan.md)) | LIVE test ([R] `lib/invoices/resolve-payment-methods.ts`) | Diff |
| 124 | Tap-to-pay / in-field card capture | FLD | ServiceTitan, Simpro | MISSING (field system owns it) | Partner |
| 125 | AI cash application (lumped and partial remittances) | AR | Versapay, HighRadius, Tesorio, Ramp Receivables | LIVE [AR-11] | Must |
| 126 | Multi-step dunning with tone ladder and stop-on-pay | AR | BILL (3 reminders), Upflow, Simpro Fast Cash, Kolleno | PARTIAL [AR-14] | Must |
| 127 | **Collections agent that sends, handles replies, applies cash** | AR AIG | Tesorio, HighRadius, Ramp Receivables, BlackLine Verity Collect | PARTIAL drafts [AR-13] | Should |
| 128 | Customer risk scoring + adaptive reminder timing | AR FLD | Simpro Fast Cash (30+ signals, [P](https://www.simprogroup.com/features/fast-cash)), Tesorio | PARTIAL [AR-12] | Should |
| 129 | Customer portal with **line-item disputes** | AR | Versapay | PARTIAL [AR-19] (no disputes) | Should |
| 130 | Customer statements + AR ledger | LED | all | LIVE [AR-15] | Must |
| 131 | Credit limits and credit holds | AR LED | HighRadius, NetSuite [U] | MISSING | Should |
| 132 | Late fees / finance charges | LED AR | QBO, Sage [U] | PARTIAL [AR-14] | Should |
| 133 | Sales receipts (POS / counter sales) | LED FLD | QBO, c-Systems [U] | PLANNED [AR-09] | Should (dealers) |
| 134 | Credit memos | LED | all | LIVE [AR-05] | Must |
| 135 | Contract → invoice schedule + rev-rec setup | AIG AR | Rillet, Campfire, Ramp AR add-on | PARTIAL [AR-18] | Should |
| 136 | Management-fee / service billing to related entities | LED | — | PLANNED [AR-20] | Must (holdco) |
| 137 | Rev rec engine (9 methods) + deferred roll-forward | LED AIG | Rillet, Campfire, DualEntry, Intacct | LIVE [REV-01..06] | Must |
| 138 | SSP / multi-element allocation (ASC 606) | AIG | Rillet, DualEntry | PLANNED [REV-09] | Later |
| 139 | Customer financing at quote; lender-funded receivable net of dealer fee | AR FLD | ServiceTitan (GreenSky, Synchrony, Service Finance, Turns), Jobber/HCP (Wisetack), Buildertrend (Nelnet), Simpro (BNPL) | MISSING | Should |
| 140 | Payments agent that drafts recurring invoices from customer behavior | AR | QBO Payments Agent | MISSING | Later |
| 141 | Unified AR aging incl. unbilled; DSO | AR FPA | all | LIVE [AR-16] | Must |

### 2.7 Spend, cards & expense
| # | Capability | Categories | Who has it | MeritBooks | Priority |
|---|---|---|---|---|---|
| 142 | Corporate & virtual cards with controls | SPD | Ramp, Brex, BILL S&E, Airbase, Mercury, Rho | MISSING (by design: Ramp owns, CG §2) | Partner |
| 143 | Card feed → GL with receipt status per transaction | SPD LED | all | LIVE [BNK-07] | Must |
| 144 | **Ramp two-way accounting connection (multi-entity, one Ramp business)** | SPD | Rillet/Campfire via API | PLANNED [BNK-08] | Must |
| 145 | Receipt capture by SMS / email / Slack / mobile | SPD | Ramp, Expensify SmartScan, QBO Accounting Agent texts the client | PLANNED [EXP-03/04] | Must |
| 146 | Receipt chase with escalation; card lock when receipts are missing | SPD | Ramp | PARTIAL [EXP-05] (no sender or scheduler) | Must |
| 147 | Missing-receipt affidavit | SPD | Ramp | MISSING | Should |
| 148 | Expense reports + reimbursement batches | SPD | Expensify, Concur, Emburse, Ramp | LIVE [EXP-08] | Must |
| 149 | Mileage + per diem (multi-stop) | SPD | Ramp (Sep 2026), Concur, Expensify | LIVE [EXP-09] | Should |
| 150 | **Policy agent compiled from an uploaded policy PDF** | SPD | Ramp controller agents ([P](https://ramp.com/blog/ramp-agents-announcement)) | LIVE [EXP-10] | Must |
| 151 | Spend analytics by cardholder/category/vendor | SPD FPA | all | PARTIAL [EXP-12] | Should |
| 152 | Travel booking | SPD | Navan, Ramp, Brex, Concur | MISSING | Partner |
| 153 | Live budgets on cards | SPD | Brex, BILL S&E, Ramp | MISSING | Partner (Ramp) |
| 154 | Cash advances | SPD | Concur [U] | PLANNED [EXP-11] | Later |
| 155 | **Ramp-vs-GL completeness check + accrue unsynced spend at month end** | SPD CLS | nobody | PLANNED [BNK-09] | Diff |
| 156 | Spend tied to plan (committed spend vs budget) | SPD FPA | Datarails Spend (Oct 2026), Ramp budgets | PARTIAL (BvA without commitments) | Should |
| 157 | Card cash-back / rebate posted to GL | SPD | BILL S&E 1.5%, Brex | MISSING | Later |

### 2.8 FP&A, reporting & lender/board output
| # | Capability | Categories | Who has it | MeritBooks | Priority |
|---|---|---|---|---|---|
| 158 | P&L / BS / TB / cash flow / equity | LED | all | LIVE [RPT-01] | Must |
| 159 | Drill from statement → transaction → source doc | LED | all | LIVE [RPT-03] | Must |
| 160 | Budgets by entity/dept/account; budget vs actual (BvA) | LED FPA | all | LIVE [FPA-01/02] | Must |
| 161 | Driver-based budgeting | FPA | Jirav, Vena, Pigment | LIVE [FPA-03] | Should |
| 162 | Rolling reforecast | FPA | Jirav, Vena, Planful | LIVE [FPA-04] | Should |
| 163 | Scenarios incl. natural-language scenarios | FPA | Float (8 layers), Vena Scenario Agent | LIVE [FPA-05] | Should |
| 164 | **Integrated 3-statement forecast** | FPA | Fathom, Reach, Spotlight, LivePlan, Jirav | PLANNED [FPA-08] | Must |
| 165 | Budget cycle with department-head submissions & approvals | FPA | Planful, Vena, Abacum [U] | PLANNED [FPA-06] | Should |
| 166 | Budget versions & audit | FPA | Planful, Vena [U] | PLANNED [FPA-07] | Should |
| 167 | Headcount/workforce planning with fully loaded cost | FPA WRK | Jirav ([P](https://help.jirav.com/staffing-simple-drivers)), Bob Finance | PLANNED [FPA-09] | Should |
| 168 | **Consolidated budgets/forecasts with eliminations** | FPA | Fathom, Syft, Reach, Spotlight (75 entities) | PLANNED [FPA-15] | Must |
| 169 | Live Excel / Sheets add-in (ledger formulas) | FPA LED | Cube, Vena, Datarails, Intacct Smart Excel, Acumatica InsightXL | PLANNED [FPA-16] | Should |
| 170 | **Scheduled, branded report packs** | FPA PRC | Fathom, Spotlight, Reach | PARTIAL [RPT-08] (no scheduler) | Must |
| 171 | AI commentary inside packs | FPA | Fathom Commentary Writer, Spotlight AI Suggestions, Syft Assist | PARTIAL [AI-09] | Must |
| 172 | Custom & non-financial KPIs (e.g. revenue per tech, membership count, backlog) | FPA | Fathom, Qvinci | PLANNED [FPA-13] | Should |
| 173 | Portfolio dashboard: every entity's health, ranked | FPA PRC | Fathom Portfolio ($0.67/company), Qvinci, Canopy book health | PARTIAL [FPA-11, CLS-11] | Must |
| 174 | Standard-COA mapping so entities' P&Ls are comparable | FPA | Qvinci, Joiin | PARTIAL (shared seed template) | Should |
| 175 | Custom report writer | LED | Intacct, NetSuite | PLANNED [RPT-10] | Should |
| 176 | Dimensional / pivot reporting | LED | IES (May 2026), Intacct | PARTIAL [DIM-06] | Must |
| 177 | Separate reporting warehouse (no load on transactional DB) | LED | Acumatica R2 data warehouse | MISSING | Later |
| 178 | Saved report views; PDF/XLSX/CSV export | LED | all | LIVE [RPT-06/07] | Must |
| 179 | Board package with MD&A | FPA | Datarails, Fathom | LIVE [FPA-14] | Should |
| 180 | **Borrower-side covenant monitor, borrowing base, compliance certificates** | FPA | none found in any category | LIVE [DEBT-04/05/07] | Diff |
| 181 | Lender reporting calendar + scheduled lender packs | FPA | none found | PLANNED/PARTIAL [DEBT-08/09] | Diff |
| 182 | Lender / investor read-only portal | FPA | none found | PLANNED [DEBT-13] | Diff |
| 183 | Diligence / exit package (normalized EBITDA bridge) | FPA | none found | PLANNED [FPA-18] | Diff |
| 184 | Debt register with P&I, variable rate, LOC availability | LED | Intacct Lending Mgmt (R3) | LIVE [DEBT-01], LOC PARTIAL [DEBT-11] | Should |
| 185 | Profitability by entity / dept / job / customer | FPA | all | LIVE [FPA-11], PARTIAL [FPA-12] | Must |

### 2.9 Payroll, time & workforce
| # | Capability | Categories | Who has it | MeritBooks | Priority |
|---|---|---|---|---|---|
| 186 | Payroll register import → balanced JE | WRK LED | — | LIVE [PRL-01] | Must |
| 187 | **Embedded payroll run** (Check or Gusto Embedded) | WRK | Gusto Embedded, Check, QB Workforce, Xero (Gusto) | PARTIAL stub [PRL-04] | Must |
| 188 | Payroll GL split by job / department / entity from the provider | WRK | Gusto Embedded GL API, Rippling, QB Workforce (class/project, Premium+) | PARTIAL | Must |
| 189 | **Labor cost to jobs from actual payroll** (hours from PM/time system × actual gross + taxes + benefits), not a burden estimate | WRK FLD | ServiceTitan uses a manual burden rate it admits won't tie ([P](https://help.servicetitan.com/docs/payroll-features)); Gusto project costing only after payroll runs | PARTIAL (job cost exists; no labor distribution) | Diff |
| 190 | Certified payroll WH-347 / prevailing wage / union fringes | WRK | ADP WFN Construction, Miter, Trayd (on Check), Points North | PLANNED [PRL-11] | Partner |
| 191 | Workers' comp class code per earning; pay-as-you-go WC | WRK | Check (WA L&I per earning), NEXT | MISSING | Partner |
| 192 | Multi-entity payroll calendar / status monitor | WRK PRC | Gusto Payroll Digests API (25 companies/call), Rippling | PARTIAL (hr.upcoming planned) | Should |
| 193 | Payroll liability tie-out to $0; remittance | WRK CLS | — | LIVE [PRL-06/07] | Must |
| 194 | **Performance pay: tech commissions, spiffs, range bonuses, split by invoice %** | WRK FLD | ServiceTitan Performance Pay ([P](https://help.servicetitan.com/docs/performance-pay-overview)), RFMS GP commissions [U] | MISSING | Should |
| 195 | Commission accrual to GL when the invoice posts, paid when the invoice is paid | WRK FLD LED | none found native in a GL | MISSING | Diff |
| 196 | GPS/geofenced crew time by cost code | WRK FLD | Workyard, ClockShark, busybusy, QB Time, Connecteam | **RETIRED in Books** (PM module / provider) | Partner |
| 197 | Equipment hours (work vs idle) to job cost | WRK FLD | busybusy | MISSING | Later |
| 198 | Earned wage access | WRK | Clair (Gusto/Check), Paylocity, Tapcheck | MISSING | Partner |
| 199 | Payroll funding check (funding account vs net pay) | WRK | — | PLANNED [PRL-10] | Should |
| 200 | W-2s, filings, garnishments, new-hire reports | WRK | all payroll | PLANNED via provider [PRL-08] | Partner |

### 2.10 Tax & vendor compliance
| # | Capability | Categories | Who has it | MeritBooks | Priority |
|---|---|---|---|---|---|
| 201 | Sales-tax rate engine (effective-dated) | TAX LED | Avalara, TaxJar, QBO Sales Tax Agent | LIVE engine, PARTIAL provider [TAX-01] | Must |
| 202 | Sales-tax returns + GL tie-out + filing calendar | TAX | Avalara, TaxJar | LIVE [TAX-02] | Must |
| 203 | Filing & remittance via provider | TAX | Avalara Returns, TaxJar AutoFile [U] | PLANNED [TAX-04] | Partner |
| 204 | Exemption certificate management (collect, validate, expire) | TAX | Avalara ECM [U] | MISSING | Should |
| 205 | Contractor taxability (lump-sum vs T&M; materials vs labor by state) | TAX FLD | Avalara [U] | MISSING | Should |
| 206 | Nexus monitoring | TAX | Anrok, TaxJar, Avalara | LIVE [TAX-03] | Should |
| 207 | 1099 NEC/MISC federal e-file + **state (CF/SF)** | TAX AP | BILL, Ramp ($0.65), Tax1099, Track1099, QB | PARTIAL [TAX-05] (needs IRS TCC) | Must |
| 208 | **IRS TIN matching** | TAX AP | Tax1099, Track1099, Tipalti [U] | MISSING | Must |
| 209 | 1099 tracking across entities | TAX | — | LIVE [TAX-06] | Must |
| 210 | COI AI parse (ACORD 25) + W-9 parse | TAX AP | myCOI, TrustLayer, Jones [U] | LIVE [VND-02] | Must |
| 211 | **Endorsement verification** (AI; waiver of subrogation, primary/non-contributory) | TAX FLD | TrustLayer, Jones, myCOI [U] | MISSING | Should |
| 212 | Insurance requirement templates per contract / job / vendor type | TAX FLD | myCOI, TrustLayer, Billy [U] | MISSING | Should |
| 213 | Live-policy verification (carrier-connected; cancellation alerts) | TAX | Certificial [U] | MISSING | Partner |
| 214 | Auto-chase expiring docs (vendor + broker) | TAX AP | myCOI, TrustLayer [U] | PARTIAL [VND-04] (no sender) | Must |
| 215 | Book-to-tax M-1/M-3, ASC 740 provision, return package | TAX LED | — (none of the SMB/AI-native GLs found) | LIVE [TAX-07/08/09] | Diff |
| 216 | Payroll/property/state filing grid with penalty exposure | TAX | — | PARTIAL [TAX-10] | Should |

### 2.11 Practice / firm (tenant = accounting firm or holdco finance team)
| # | Capability | Categories | Who has it | MeritBooks | Priority |
|---|---|---|---|---|---|
| 217 | **Books-health file review across all clients** (miscoding vs history, uncategorized, unreconciled) | PRC | Double file reviews ([P](https://doublehq.com)), Canopy Close Automation, Financial Cents MEC | PARTIAL [CLS-11, CTRL-01] | Must |
| 218 | **"Ask the client" transaction questions** via portal, carried month to month, reclassify on answer | PRC | Double, Financial Cents ($5/client), Canopy, QBOA [U] | PLANNED [PRT-01] | Must |
| 219 | Client document requests with reminders | PRC | Karbon, TaxDome, Financial Cents | PLANNED [PRT-01/02] | Must |
| 220 | Client portal + mobile app with magic link | PRC | Double, TaxDome | PARTIAL [PRT-03] | Should |
| 221 | Recurring workflow templates beyond close | PRC | Karbon, Uku, Financial Cents (400+ templates) | PARTIAL [ADM-22] | Should |
| 222 | Staff capacity planning | PRC | Karbon, Canopy | PLANNED [ADM-09] | Should |
| 223 | Proposals / engagement letters / e-sign / price insights | PRC | Ignition, Karbon, Canopy | MISSING | Partner (Ignition) |
| 224 | Per-client economics / realization (no time tracking) | PRC | Karbon, Canopy (time-based) | PLANNED [ADM-23] | Diff |
| 225 | White-label portal, reports and domain | PRC FPA | Spotlight, Reach, Uku | PARTIAL [ADM-17] | Diff (resale) |
| 226 | Per-client pricing for firms | PRC | Double, Fathom, Digits | PARTIAL [ADM-12] | Must |

### 2.12 Trades / field / industry finance
| # | Capability | Categories | Who has it | MeritBooks | Priority |
|---|---|---|---|---|---|
| 227 | Jobs as a GL dimension with job P&L and cost codes | LED FLD | Sage 300 CRE, Intacct, Acumatica, all field systems (report-level) | LIVE [REV-10] | Must |
| 228 | **Cost code × cost type budgets: original / revised / committed / projected / cost-to-complete** | LED FLD | Procore [U], Buildertrend, Acumatica, Intacct | PARTIAL [REV-11] | Must |
| 229 | Change orders that adjust contract value + SOV + budget | LED FLD | Procore, Sage 300 CRE, Buildertrend (ServiceTitan uses linked estimates) | LIVE [REV-10] | Must |
| 230 | **GL-native WIP schedule: over/under billing, EAC, ties to GL** | LED FLD | Intacct Construction, IES Construction, Sage 300 CRE. **Not produced by Buildertrend/ServiceTitan syncs** ([3P](https://liveflow.com/blog/buildertrend-quickbooks-integration-closing-the-wip-and-draw-reporting-gap)) | LIVE [REV-12] | Diff |
| 231 | EAC / profit-fade prediction | FLD LED | IES Construction PM Agent, Acumatica, Intacct | PARTIAL [REV-13] | Should |
| 232 | **AIA G702/G703 progress billing from SOV, in Books** | LED FLD | Sage 300 CRE, Intacct, Acumatica, ServiceTitan, INNERGY, Procore | PARTIAL [AR-08] (Projects app only; `008_sub_ledgers.sql` has application_number) | Must |
| 233 | Draw schedules by % / milestone with auto-dated draft invoices | FLD | Buildertrend ([P](https://buildertrend.com/help-article/invoice-overview/)) | PARTIAL [AR-08] | Should |
| 234 | **Retainage receivable/payable: by line, sliding scale, cap, release alerts, final-claim rebate** | LED FLD | Intacct R3 (tiered by subcontract line), Simpro ([P](https://helpguide.simprogroup.com/Content/Service-and-Enterprise/Retention.htm)), Acumatica, ServiceTitan | LIVE [REV-14] (no nav entry; cap/sliding [U]) | Must |
| 235 | **Request-for-claim**: non-posting pre-approval invoice that converts on approval | FLD | Simpro ([P](https://www.simprogroup.com/blog/a-snapshot-of-project-invoicing-and-payments-in-simpro)) | MISSING | Should |
| 236 | **Allowances & selections**: overage → invoice, underage → credit memo/CO | FLD | Buildertrend ([P](https://buildertrend.com/help-article/selections-and-allowances-overview/)) | MISSING | Should (K&B, homebuilding) |

*(Rows 237+ intentionally omitted. The rest of the trades set appears in §5 so it isn't double-counted: service agreements,
memberships, van stock, floor plan, warranty, flooring and cabinet items. §5.1 lists each one with its status and what to build.)*

**Totals (rows 1–236, counted from the table by first-listed status):** LIVE **78** · PARTIAL **58** · PLANNED **61** ·
MISSING **38** · RETIRED-in-Books **1** (row 196, crew time, which comes from the PM module or a provider). MISSING includes
Partner/Not-recommended items the platform doesn't need to build.

---

## 3. What we're missing — ranked, with a concrete product description

Ranked by revenue impact for the target segment (holdcos and firms serving trades) × how often the gap blocks a QuickBooks
replacement, with effort shown separately [J]. Items already sequenced in CG §4 (scheduler, approval enforcement, group close
gate, watch rules, MCP) are kept, but their descriptions are not repeated in depth.

1. **Ramp two-way accounting connection** [BNK-08/09]
   - Ramp business with all entities → MeritBooks pushes COA, dimensions, vendors and entities.
   - Pulls `ready_to_sync` card transactions, bills and reimbursements with receipts.
   - Pairs the statement payment so nothing is counted twice.
   - Completeness check plus accrual of unsynced spend.
   - Why: multi-entity Ramp **cannot** run on QBO ([P](https://support.ramp.com/hc/en-us/articles/49904858586131-Ramp-support-for-QuickBooks-Online-QBO-and-Intuit-Enterprise-Suite-IES)), so this is a structural win.
2. **Field-system ingestion with per-document tie-out** [REV-19, INT-11; mechanics in 07]
   - Sources: ServiceTitan, simPRO, RFMS (direct); Buildertrend, INNERGY, c-Systems, FieldEdge (bridge).
   - Each invoice, payment, bill and PO arrives as an idempotent event keyed to the source ID.
   - A daily "source vs GL" tie-out lists every document that didn't land and why (period closed, unmapped item).
   - Fixes the #1 complaint class (§4.3).
3. **Service agreements & memberships** (new object)
   - Agreement: customer, sites, term, price, visits included, billing frequency, auto-renew.
   - Billing schedule posts to deferred revenue. Recognition is straight-line or per-visit (completed visit events from the field system).
   - Failed-card retry queue; renewal pipeline.
   - Reports: deferred-revenue roll-forward, churn, MRR by entity.
   - Why: ServiceTitan's version stays off the invoice GL ([P](https://help.servicetitan.com/docs/grow-recurring-revenue-with-memberships)); HVAC holdcos need it for valuation (recurring revenue multiple).
4. **Progress billing in Books** [AR-08, REV-14]
   - Contract SOV with change-order lines → G702/G703 pay app.
   - Stored materials; retainage per line with cap and sliding scale.
   - Request-for-claim (non-posting) → approved invoice.
   - Draw schedules for residential (by % or milestone).
   - Retainage gets its nav entry back.
5. **Lien waivers + subcontractor compliance pack gated to payment** [REV-17/18]
   - Port the Projects precondition (`PRECONDITION_LIEN_WAIVER`, [R] mig 1005) into Books pay runs.
   - Conditional waiver required before release; unconditional collected after clearing.
   - Plus COI, W-9 and certified payroll per job. One "pay-ready" badge per sub per job.
6. **Cross-entity bill pay + allocations engine** [AR-20]
   - Pay entity B's bill from entity A's account; due-to/due-from posts automatically.
   - Allocation rules by %, statistical driver or revenue, e.g. shared insurance, management fee, shared admin.
   - Always as **explicit intercompany invoices/JEs** — never the retired overhead burden engine.
   - Matches IES May 2026.
7. **Embedded payroll + labor distribution to jobs** [PRL-04]
   - Provider: Check or Gusto Embedded (owner decision, task #32).
   - Payroll JE split by entity / department / job from approved hours (from the PM module or a time provider).
   - Certified payroll via a partner layer (Miter/Trayd-style on Check).
8. **Receipt capture by SMS/email + chase sender** [EXP-03/04/05]
   - Reply-to-text receipt capture; email-forward intake.
   - Escalation ladder; Ramp card lock for missing receipts via the Ramp API; missing-receipt affidavit.
9. **"Ask the client" loop** [PRT-01]
   - Questions on transactions, with AI-suggested answers.
   - Magic-link portal; carried month to month; the answer reclassifies in-ledger (no write-back needed).
   - Practice tools charge $5–50/client/month for this as a bolt-on.
10. **Scheduled report & lender packs with AI commentary** [RPT-08, DEBT-08/09, AI-09]
    - Pack builder → schedule → branded PDF/XLSX → human-approved send.
    - Lender calendar (certificate/BBC due dates) feeding the same sender.
11. **3-statement forecast + consolidated budgets** [FPA-08/15]
    - Linked P&L/BS/cash forecast per entity and per group, with eliminations.
    - AR/AP/inventory day-assumptions; scenarios layered on top.
12. **Commission & performance-pay engine** (new)
    - Rules per item, category or salesperson: % of revenue or gross profit, flat spiff, range bonuses.
    - Split by invoice share. Accrued when the invoice posts; payable when paid (or on posting).
    - Exported to payroll as earnings codes.
    - Sources: ServiceTitan performance pay; RFMS GP commissions [U].
    - Note: this is a payroll earnings calculation, **not** the retired workforce chargeback engine. Owner to confirm (§6 note).
13. **1099 completeness: IRS TIN matching + state filing via provider** [TAX-05]
    - TIN/name match at vendor onboarding.
    - Combined Federal/State plus direct state filing.
    - Per-form pricing in line with market ($0.65–$2.99).
14. **Vendor bank-change verification that blocks + OFAC screening**
    - Bank-detail change → payments frozen → out-of-band confirmation (call-back or portal 2FA) → unfreeze, all audited.
    - OFAC screen at vendor create and at release.
15. **Payment rails through a licensed provider** [PAY-09/11]
    - ACH and same-day ACH, mailed checks, virtual card with rebate share.
    - Positive pay file and bank exception decisioning.
16. **COI depth** [VND-02]
    - Requirement templates by vendor type or job (limits, additional insured, waiver of subrogation, primary/non-contributory).
    - AI endorsement-page check; broker-direct chase.
    - Optional live-policy partner (Certificial-class).
17. **Dealer pack** (power equipment; c-Systems tenants)
    - Serialized whole-goods inventory with landed cost.
    - **Floor-plan liability subledger per serial**: lender, curtailment schedule, interest accrual, payoff on sale, curtailment-due alerts.
    - **OEM warranty-claim receivable** with aging and reimbursement match.
    - Rental fleet depreciation (FA exists).
18. **Multi-location inventory incl. trucks** [INV-04]
    - Location = warehouse / van.
    - Min/max replenishment proposals → POs inheriting the tech's entity and department.
    - Cost relieved to the job when consumed (event from the field system).
19. **Customer credit control**
    - Credit limits and holds by customer.
    - Disputes per invoice line in the portal (Versapay model).
    - Collections agent that sends and handles replies [AR-13].
20. **Consumer-financing accounting**
    - Lender-funded receivable (GreenSky/Synchrony/Wisetack…).
    - Dealer fee expensed; funding matched on the bank feed.
    - Financing penetration KPI per entity.
21. **Benchmarking for trades** [FPA-19]
    - Opt-in pooled KPIs per trade: gross margin, revenue per tech, membership attach, DSO, WIP fade.
    - Ranks each portfolio company against peers. Qvinci/Fathom do this generically; nobody does it per trade.
22. **Excel add-in** [FPA-16]
    - Read-only ledger formulas (balance by account/dimension/period), refreshable. FP&A buyers expect it.
23. **SSO/MFA/passkeys + SOC 2** [ADM-16]
    - Required before tenant #2 and by every competitor's security page.
24. **Public API + webhooks** (not in 04)
    - Versioned REST with scopes, rate limits and sandbox (DualEntry: 200 req/min, CLI, sandbox).
    - Pairs with MCP.
25. **Exemption certificates + use tax + contractor taxability**
    - Collect and expire customer exemption certificates.
    - Accrue use tax on untaxed material purchases.
    - Lump-sum vs T&M contract taxability per state (via Avalara-class provider).
26. **Budget cycle with department heads + versions + headcount planning** [FPA-06/07/09].
27. **Working papers with sign-off** [CLS-07] and reviewer return loop [CLS-08].
28. **Allowances/selections** (K&B, homebuilders) and **request-for-claim** (rows 235–236).
29. **Pay-when-paid linkage**
    - Sub payable flagged "released when owner pays draw N".
    - Shows in pay-run proposals and the cash forecast.
30. **Installer piece-rate pay** (flooring)
    - Labor items → installer payable by job; callbacks booked as **installer back-charges** (vendor credits).

---

## 4. What we can do better — where incumbents are weak (user evidence) and how MeritBooks wins

Quotes are short excerpts. [V] means the research pass opened the page and checked the wording; [S] means search excerpt only.
No Reddit evidence (blocked).

| # | Incumbent weakness | Evidence | How MeritBooks wins |
|---|---|---|---|
| 4.1 | **Price hikes, forced upgrades and renewal traps** | QBO Plus $70→$115 and Advanced $150→$275 (2020–25) [V] ([Woodard](https://report.woodard.com/articles/intuit-announces-2025-quickbooks-price-increases-fpwr)); Advanced up ~70% in Aug 2026 [3P] ([beancount](https://beancount.io/blog/2026/08/25/quickbooks-online-price-hike-advanced-70-percent-guide)); "increased their price on average by 15% per year… now double" [V] ([AccountingWEB](https://www.accountingweb.co.uk/any-answers/quickbooks-qbo-prices-hiked-yet-again)). NetSuite: "significant price increase of 40%… 'auto renewal' if we not decide today" [V] ([NetSuite Professionals](https://archive.netsuiteprofessionals.com/t/23403953/hello-we-are-netsuite-user-since-3-years-and-our-contract-is)). Avalara: "more than doubled my renewal and then charged my credit card" [V] ([BBB](https://www.bbb.org/us/wa/seattle/profile/computer-software-developers/avalara-1296-22018273/customer-reviews)). Procore: "12% increase at renewal with zero new features" [S] ([constructable](https://constructable.ai/blog/procore-reviews-pricing-alternatives)) | Published per-entity price with a **multi-year price lock**; no per-seat tax on approvers; one invoice replaces 8–12 tools. Publish a "tools you can cancel" calculator per entity (QBO + BILL + Expensify + Fathom + Double + Avalara 1099 + COI tracker) |
| 4.2 | **Usage caps used to force upgrades** | QBO clients "subscriptions cancelled… without warning" over class/location limits; "re-subscribed under the Advanced plan" [V] ([AccountingWEB](https://www.accountingweb.co.uk/any-answers/quickbooks-qbo-unilaterally-unsubscribing)); Plus capped at 40 classes+locations [S] ([Insightful Accountant](https://insightfulaccountant.com/accounting-tech/general-ledger/quickbooks-online-usage-limits-did-you-know)). Trades companies tracking jobs/crews/locations hit 40 quickly | Unlimited dimensions and jobs at every tier [DIM-01]. Say so loudly in sales |
| 4.3 | **Multi-entity by duplicating subscriptions** | QBO: "you have to create multiple accounts" [S] ([Intuit](https://quickbooks.intuit.com/learn-support/en-us/other-questions/online-subscription/00/1353543)); Ramp on QBO/IES: "Each entity must be connected to its own Ramp account… does not currently support intercompany" [V] ([Ramp](https://support.ramp.com/hc/en-us/articles/49904858586131-Ramp-support-for-QuickBooks-Online-QBO-and-Intuit-Enterprise-Suite-IES)); Xero "doesn't currently provide consolidated reporting" [S]; BILL multi-entity gated to Corporate ($89/user) [P]; Digits bills each entity separately [P]; consolidation "beyond 3-4 entities becomes painful" [S] ([EagleRock](https://www.eaglerockcfo.com/blog/quickbooks-guide/limitations-at-scale)) | Native multi-entity + consolidation + intercompany at no upsell; one Ramp business for all entities via the API connection; cross-entity bill pay (§3 #6) |
| 4.4 | **Sync between point tools damages the ledger** | BILL: "Sync issues have messed up our historical client data in QuickBooks" [V] ([TrustRadius](https://www.trustradius.com/reviews/bill-com-2022-08-11-10-31-09)); 10–20% of a reviewer's week on BILL support [S]. ServiceTitan: syncing with QB "has NOT happened" [S] ([Capterra](https://capterra.com/p/150053/ServiceTitan/reviews/?page=9)); help docs list exports showing "Exported" that never reached QBO [P]. Buildertrend: no class/location mapping; partial bill payments don't sync [P] ([help](https://buildertrend.com/help-article/quickbooks-online-integration-overview/)); integration "added more" duplicate entry [S]. simPRO: "credits don't get allocated to the invoices in Xero, so you're having to do the job twice" [S] ([GetApp](https://www.getapp.com/all-software/a/simpro-enterprise)) | MeritBooks *is* the ledger, so there is no sync-back. Field data comes in as idempotent events with a **per-document source-vs-GL tie-out** and plain-English failure reasons. Entity-aware mapping (field business unit → entity + department) instead of exact-name GL matching |
| 4.5 | **Construction outputs rebuilt in Excel every month** | Buildertrend→QBO sync "does not produce a WIP schedule, a draw report, or a cash-flow forecast by job"; WIP reclass is a manual JE each period; a controller keeps a frozen Excel WIP snapshot [V, competitor] ([LiveFlow](https://liveflow.com/blog/buildertrend-quickbooks-integration-closing-the-wip-and-draw-reporting-gap)). 78% of finance teams cite waiting on other systems as the #1 close delay [V, vendor survey] | GL-native WIP with over/under billing JE proposals [REV-12] (already LIVE), job cash-flow and draw report (§3 #4), period-locked WIP snapshots that never drift |
| 4.6 | **Job cost by estimate, not by actuals** | ServiceTitan labor cost = hours × manual burden rate that "will almost never match to the penny" with payroll [P] ([help](https://help.servicetitan.com/docs/payroll-features)); reports by job-completion date while QBO uses invoice date, so "revenue never ties" [S] ([community](https://community.servicetitan.com/t5/Accounting/Integrate-QuickBooks-P-amp-amp-L-on-the-ServiceTitan-Dashboard/td-p/69956)) | Labor distribution from actual payroll to jobs (§3 #7); a reconciliation view showing field-system revenue (completion date) vs GL revenue (invoice date) by job, with the timing difference explained |
| 4.7 | **Recurring revenue handled off-ledger** | ServiceTitan deferred memberships don't recognize through invoice GL entries; tracked on a report; needs support to enable [P] ([help](https://help.servicetitan.com/docs/grow-recurring-revenue-with-memberships)) | Service-agreement object with automatic recognition (§3 #3), so membership revenue is audit-ready and visible to lenders and buyers |
| 4.8 | **Implementation pain and dated UX in construction ERPs** | Sage 300 CRE: 5-month average implementation, 21-month ROI, 3.6/5 [V] ([G2](https://www.g2.com/products/sage-300-construction-and-real-estate/reviews)); "on-premise… has not kept up with the times" [S]. Intacct: rollout "nine months and was never finished correctly" [S]; reporting "powerful but very complicated" [S] ([Capterra](https://www.capterra.com/p/76/Intacct/reviews/?page=8)). IES: "core features… missing or not fully developed" after migration [S] ([G2](https://www.g2.com/products/intuit-intuit-enterprise-suite/reviews)) | Conversion with a tie-out gate in days [ONB-04]; drop-anything onboarding; field-system historical import; one consistent modern UI. Match DualEntry's "4–6 weeks, implementation included" as a public promise |
| 4.9 | **AI that's noise or a black box** | QBO "Agent insights" produce "inane drivel"; "a huge slowdown in QBO ledger reports" [V] ([AccountingWEB](https://www.accountingweb.co.uk/any-answers/quickbooks-qbo-prices-hiked-yet-again)). Stampli says outright it doesn't do fully autonomous AP [P] | Canon pattern: AI proposes, the deterministic engine posts. Every AI action is in the decision log with confidence and the rejected alternative; per-feature autonomy dial; honest "AI paused" fallback [AI-15]; flux built from deterministic drivers, with AI only writing the words |
| 4.10 | **Bank-feed rules fail silently** | QBO auto-add rules stop applying; moderators answer "clear cache / try incognito" [S] ([Intuit](https://quickbooks.intuit.com/community/banking-currency-66/why-don-t-auto-add-rules-work-158645)) | Every auto-categorization shows *which* rule/memory/AI decided it [BNK-05 confidence explainer]; a "rules that didn't fire" exception; rule hit-rate per rule |
| 4.11 | **Support decay; no backup or exit** | QBO: "customer service has steadily degraded" [S] (G2); "There is no facility to back up and restore" [V]; Trustpilot: "Quickbooks has lost our 2025 accounting data" [S]. Avalara: "you no longer can speak with anyone" [V] | Full tenant export at any time (journal, subledgers, documents) [ONB-12]; named onboarding rep [ONB-09]; in-product support access that is consented, time-boxed and logged [ADM-15] |
| 4.12 | **Practice tools sit on top of QBO and have to write fixes back** | Double "writes fixes back to QBO/Xero" [P]; Canopy/Financial Cents sell close automation per client [P]; Double sends notifications "to EVERYONE, even if user doesn't have the correct permission to view financials" [S] ([Software Advice](https://www.softwareadvice.com/product/490399-Double/reviews/)) | Review, ask-client and reclassify happen in the ledger with role-scoped visibility (client-scoped RLS, ADM-04). The firm cockpit is included, not a $5–50/client add-on |
| 4.13 | **Bank-change fraud controls are weak at the low end** | BILL notifies the vendor of a bank change but doesn't require confirmation before paying [P] ([BILL help](https://vendorpayhelp.bill.com/hc/en-us/articles/360056648731)) | Freeze-until-verified (§3 #14) on top of the existing release-time fraud screen [PAY-04] |
| 4.14 | **FP&A tools need heavy data mapping and can't consolidate across systems** | Jirav: "consolidating multiple accounting systems not available"; subsidiaries need the same FYE and currency [P] ([help](https://help.jirav.com/actuals/integration-capabilities)); "upfront data mapping work"; month-end performance bottlenecks [S] | FP&A runs on the same ledger: no mapping, no sync lag, budgets per entity and consolidated on the same chart |
| 4.15 | **Nobody serves the borrower** | No competitor found offering covenant monitoring, borrowing-base certificates or lender calendars from the ledger (all six passes) | Already LIVE [DEBT-04/05/07]. Add the lender calendar, scheduled packs and lender portal (§3 #10) and market it as a lead feature for holdcos with bank debt |
| 4.16 | **Card fees eat margin in the field** | ServiceTitan: "no option to automatically charge for credit card fees" [P] | Surcharge pass-through with ACH absorb already built [R]. Make it per-entity / per-customer configurable and state-compliant (surcharge caps/bans) |

---

## 5. Field systems — finance features worth adopting or integrating

Rule of thumb [J]:
- **Adopt natively** when the feature creates or changes a GL balance and the field system handles it badly or not at all
  (deferral, retainage, WIP, commissions accrual, floor plan).
- **Integrate** when it is an operational or field workflow, or regulated (dispatch, pricebook, time clock, financing
  origination, card terminals, payroll gross-to-net).
- Ingestion mechanics are in 07.

### 5.1 Feature-by-feature
| Theme | Who does it & how (source) | Decision | MeritBooks today | What to build |
|---|---|---|---|---|
| **Job costing** | ServiceTitan: materials + POs + payroll; labor via manual burden rate; completion-date basis ([P](https://help.servicetitan.com/docs/run-job-costing-reports.md)). Buildertrend: budget with cost-to-date and remaining, labor from Time Clock ([P](https://buildertrend.com/help-article/buildertrend-glossary/)). INNERGY: actuals from purchases + time vs estimate ([P](https://www.innergy.com/?p=6561)). Simpro: actual vs original/revised/current budget ([P](https://www.simprogroup.com/blog/a-snapshot-of-project-invoicing-and-payments-in-simpro)) | **Adopt** (GL-native) + **ingest** source costs | LIVE jobs/cost codes [REV-10]; budgets PARTIAL [REV-11] | Cost code × cost type; original/revised/committed/projected/cost-to-complete; labor from actual payroll (§3 #7); completion-vs-invoice date tie view |
| **Progress billing / AIA** | ServiceTitan G702/G703 from SOV; retainage configured before first pay app; change orders as linked estimates ([P](https://help.servicetitan.com/docs/bill-for-project-progress)). INNERGY AIA Form B with change orders and retainage ([P](https://support.innergy.com/en/articles/16008931-billing-history-part-2)). Buildertrend draw schedules by %/milestone; no AIA found ([P](https://buildertrend.com/help-article/invoice-overview/)). Simpro progress claims by %/amount/item + request-for-claim ([P](https://helpguide.simprogroup.com/Content/Service-and-Enterprise/Progress-Claim.htm)) | **Adopt** | PARTIAL [AR-08] (Projects app) | §3 #4: SOV → G702/G703, draws, request-for-claim, stored materials |
| **Retainage** | Simpro: cap 5% of contract, 10% per claim, 12-month period, sliding scale, final-claim rebate, release alerts ([P](https://helpguide.simprogroup.com/Content/Service-and-Enterprise/Retention.htm)). Intacct R3: tiered retainage per subcontract line ([3P BPM](https://www.bpm.com/insights/sage-intacct-2026-release-3/)). ServiceTitan recommends a separate retainage-receivable account [P] | **Adopt** | LIVE [REV-14] (no nav) | Add cap / sliding / per-line / release alert / rebate; restore nav; retainage aging in AR and AP |
| **Change orders** | Procore change events → potential change orders (PCOs) → commitment & prime change orders (COs) [U]; Buildertrend client/builder COs [P]; ServiceTitan uses linked estimates (weak) [P] | **Adopt** | LIVE [REV-10] | Pending vs approved COs in budget and WIP; CO → SOV line |
| **Service agreements / memberships** | ServiceTitan: monthly→annual billing, daily auto-charge, failed-payment handling, renewal estimates; deferral straight-line or per-visit; *not via invoice GL* ([P](https://help.servicetitan.com/docs/set-up-deferred-revenue-for-service-agreements.md)). Simpro Maintenance Planner: asset-driven recurring jobs and SLAs ([P](https://www.simprogroup.com/features/maintenance-planner)). FieldEdge / HCP / Jobber: service plans [U] | **Adopt** the financial object; **ingest** visits | MISSING (rev-rec methods exist [REV-01]; recurring invoices [AR-04]) | §3 #3 |
| **Tech commissions / spiffs / performance pay** | ServiceTitan: item flags (commission, flat/% spiff), range bonuses by revenue tier, split by invoice %, material cost deducted, posted invoices only; output is a Master Pay File to payroll ([P](https://help.servicetitan.com/docs/performance-pay-overview)). RFMS: GP-based salesperson commissions paid on invoice payment [U] | **Adopt** the accrual and GL; **ingest** calculations where the field system already computes them | MISSING | §3 #12. Accept ServiceTitan's computed performance pay as input; compute natively for RFMS/Buildertrend tenants |
| **Inventory / van stock** | ServiceTitan: min/max per location incl. trucks → Replenishment PO inheriting tech's business unit; PO approval tiers by $ ([P](https://help.servicetitan.com/docs/replenish-items-with-purchase-orders)). Simpro: wholesaler price feeds (ADI, Reece, Rexel) ([P](https://marketplace.simprogroup.com/t/integration-type/supplier-slash-wholesaler-integrations)). INNERGY: kiosk stock and demand-driven POs ([P](https://www.innergy.com/overview)) | **Adopt** valuation + location subledger; **integrate** replenishment ops | LIVE items/FIFO [INV-01/02]; multi-location PLANNED [INV-04] | §3 #18. Truck = location; consumption events from the field system relieve cost to the job; month-end inventory tie-out per location |
| **Purchase orders** | ServiceTitan AP automation: Payables Inbox OCR + 3-way match + approvals (Jan 2026) ([P](https://www.servicetitan.com/press/servicetitan-introduces-ap-automation-and-expands-fintech-suite)); Buildertrend POs → bills with lien waivers ([P](https://buildertrend.com/help-article/advanced-purchase-orders-bills-overview/)); INNERGY POs from material demand | **Adopt** (Books owns AP) + **ingest** field POs as commitments | LIVE [AP-11] | Field-originated POs flow in as commitments against job budgets; the bill matches in Books |
| **Payroll / time on jobs** | ServiceTitan: Master Pay File, job vs non-job hours, partners Miter and Inova (posts payroll journals to Intacct/Acumatica/QBO) ([P](https://help.servicetitan.com/docs/payroll-features)). INNERGY: time exported to payroll [P]. Buildertrend Time Clock pushes time to QBO [P]. Workyard/ClockShark/busybusy GPS time [P] | **Integrate** time (in-app time tracking is RETIRED); **adopt** labor distribution to the GL | Register import LIVE [PRL-01]; embedded STUB [PRL-04] | §3 #7. Hours come in from field system / PM module / time provider → payroll provider → job-split payroll JE |
| **Consumer financing** | ServiceTitan: GreenSky, Service Finance, Synchrony, Financeit, Turns waterfall; pre-screen 2026; contractor pays dealer fees ([P](https://www.servicetitan.com/features/customer-financing)). Buildertrend: Nelnet Bank loans up to $150K ([P](https://buildertrend.com/press-releases/homeowner-financing-partner-nelnet/)). Jobber/HCP: Wisetack [3P]. Simpro: BNPL ([P](https://www.simprogroup.com/features/payments)) | **Integrate** origination; **adopt** the accounting | MISSING | §3 #20: lender-funded receivable, dealer-fee expense, funding match on feed, penetration KPI |
| **Payments & surcharging** | ServiceTitan: Tap to Pay, Pay by Bank, no auto surcharge [P]. Buildertrend: one-click fee pass-through (Adyen) [P]. Simpro: payment links, portal, Tap to Pay, direct debit, recurring auto-pay [P] | **Adopt** online pay + surcharge (done); **integrate** field terminals | LIVE test [AR-10], surcharge [R] | Ingest field-captured payments as deposits matched to invoices; state surcharge compliance rules |
| **Deposits** | ServiceTitan deposits/overpayments [P]; Buildertrend deposit payments sync [P]; RFMS order deposits [U] | **Adopt** | LIVE [AR-07] | Map field deposits → 2420 customer deposits; apply on invoice |
| **Lien waivers** | Buildertrend custom waiver forms on bills, per job [P]; Procore Pay collects before release [U]; AvidXchange [P]; Ramp for Construction verifies before payment [P] | **Adopt** | PLANNED [REV-17] (Projects has it) | §3 #5 |
| **Allowances / selections** (K&B, homebuilding) | Buildertrend: overage → invoice, underage → credit memo/CO; open-book vs fixed-price handling ([P](https://buildertrend.com/help-article/selections-and-allowances-overview/)) | **Adopt** the billing effect; **integrate** selection UX | MISSING | Allowance lines on contracts; variance → CO or credit memo; shown in WIP |
| **Flooring estimating → billing** (RFMS) | RFMS: measure → quote/order with deposits → special-order POs to mills → roll/dye-lot/cut inventory with per-cut cost relief → job GP → installer piece-rate pay → GP commissions; own GL/journal package ([P GL](https://rfms.support.cyncly.com/hc/en-us/articles/50200023050129); rest [U]) | **Integrate** (RFMS stays operational); **adopt** installer payable + commission accrual + job GP in GL | MISSING (RFMS connector P1 in 07) | Ingest orders/invoices/payments/cost relief; installer payables by job; installer back-charges as vendor credits; GP commissions (§3 #12, #30) |
| **Cabinet estimating → BOM → billing** (INNERGY) | Parametric takeoff → drafting/CNC sync → BOM → demand POs → kiosk inventory → job cost vs estimate → AIA Form B ([P](https://www.innergy.com/overview)) | **Integrate** (no public API: bridge via QBO/Excel per 07) | MISSING connector | Ingest invoices/AIA billings, POs, job cost; WIP and over/under in Books (INNERGY WIP unconfirmed) |
| **Dealer floor-plan financing** (c-Systems) | Infinity DMS has its own GL with a GL Interface Wizard ([P](https://infinity.csystemssoftware.com/knowledgeBase/17308915)); floor-plan tracking per unit, curtailments, OEM warranty claims, rentals [U] | **Adopt** floor-plan subledger + warranty receivable; **integrate** DMS ops | MISSING | §3 #17 dealer pack. Lenders typically Wells Fargo CDF, Synchrony, Sheffield/Truist [U]. Curtailment-due feeds the cash forecast + obligations calendar [CASH-08] and borrowing base [DEBT-07] |
| **AI collections** | Simpro Fast Cash: risk tiers from 30+ signals, adaptive timing, stops on payment, "34% faster" (vendor claim) ([P](https://www.simprogroup.com/features/fast-cash)); ServiceTitan collections agent "coming soon" [P] | **Adopt** | PARTIAL [AR-12/13] | Risk tier + adaptive cadence + stop-on-pay + send/handle replies |
| **Accounting periods / internal ledger** | ServiceTitan: accounting periods, audit trail, Transaction Hub, JE export (QBO/Intacct/CSV) ([P](https://www.servicetitan.com/features/accounting)) | **Integrate** (consume its JE/transaction stream) | PLANNED | Ingest at document level, not summarized JEs, so drill-down to the ServiceTitan invoice survives |

### 5.2 Per-system "take this" list
- **ServiceTitan:**
  - Membership deferral (do it in-GL).
  - Performance-pay rules model.
  - Truck replenishment POs that inherit the tech's business unit.
  - Retainage configured before the first pay app.
  - Financing waterfall (integrate).
  - Ramp-in-AP shows the spend layer belongs to Ramp.
  - Avoid its failure modes: exact-name GL mapping, "Exported" without landing, completion-date basis.
- **Buildertrend:**
  - Draw schedules tied to schedule milestones.
  - Allowances → invoice/credit.
  - Lien waivers attached to bills.
  - One-click surcharge pass-through.
  - Homeowner financing.
  - Its QBO gaps (no class/location, no partial payments, one Xero org) are the sales script.
- **INNERGY:** AIA Form B; demand-driven POs; estimate-vs-actual job costing. Connect via bridge until Innergy grants API access (07).
- **Simpro:**
  - Retention model (cap, sliding scale, rebate, release alert).
  - Request-for-claim.
  - Per-user dollar approval limits on invoices.
  - Fast Cash risk scoring.
  - Maintenance Planner (service contracts by asset/site).
- **RFMS:** Roll/cut inventory stays in RFMS. MeritBooks takes job GP, installer payables, GP commissions, deposits and AR. RFMS's own GL is replaced, not synced.
- **c-Systems Infinity:** Its GL is replaced. MeritBooks adds the floor-plan subledger, warranty receivable, serialized whole-goods valuation, rental fleet and counter sales [AR-09].
- **Procore** [U]: Commitments with SOV; subcontractor pay applications with per-line retainage; Procore Pay lien-waiver gating. Model for §3 #5 and REV-18.
- **Jobber / Housecall Pro / FieldEdge:** Mainly ingestion sources (invoices, payments, service plans). Wisetack financing accounting; FieldEdge's QBD-centric customers are migration targets.

---

## 6. Top 25 additions — build-priority order

Effort [J]:
- **S** ≈ ≤1 week for one builder slice.
- **M** ≈ 2–4 weeks / 2–3 slices.
- **L** ≈ 5+ weeks or depends on an external partner.

Order respects CG §4 (Merit go-live first), the integration phases in 07, and the canon (migrations serialized through the lead;
FPB before build).

| # | Addition | Why now | Builds on | Effort |
|---|---|---|---|---|
| 1 | **Scheduler** (crons: feeds, detectors, packs, chase, rev-rec run, reminders) | Unblocks 8 of the items below; nothing proactive works without it | INT-01 | S |
| 2 | **Approval enforcement on every money doc; one policy for people and agents** | Controls promise; prerequisite for agent writes and MCP | CTRL-04, GL-08 | M |
| 3 | **Ramp two-way accounting connection + completeness + unsynced-spend accrual** | Merit rollout timing (CG §2); a structural multi-entity win over QBO | BNK-08/09 | L |
| 4 | **Field-system ingestion framework + per-document tie-out** (simPRO, RFMS direct; QBO bridge lane for Buildertrend/INNERGY/c-Systems/FieldEdge) | Merit's companies can't leave QBO without it; it fixes the #1 complaint class | REV-19, INT-11, 07 Phase 1 | L |
| 5 | **Progress billing in Books** (SOV → G702/G703, draws, request-for-claim, retainage cap/sliding/rebate, retainage nav) | Core trades must-have; matches Sage 300 CRE / Intacct / Acumatica / ServiceTitan | AR-08, REV-14 | M |
| 6 | **Lien waivers + subcontractor compliance pack gated to pay runs** (port from Projects) | Ramp and AvidXchange already sell it; low effort because the logic exists | REV-17/18, VND-03 | M |
| 7 | **Service agreements & memberships** (object, billing, deferral straight-line/per-visit, renewals, failed-card queue) | HVAC holdco valuation driver; ServiceTitan's weak spot | REV-01, AR-04 | M |
| 8 | **Cross-entity bill pay + allocation rules + management-fee billing** | Holdco must-have; matches IES May 2026 | CON-05, AR-20 | M |
| 9 | **Group close gate + post-close package** | Holdco close; CG#5 | CLS-09 | M |
| 10 | **Watch rules & proactive alerts** (email/Slack/Teams) | Owner/CFO value; table stakes vs cfo.ai and Fathom | CTRL-11, INT-13 | M |
| 11 | **MCP server** (read + role-scoped proposals; locked periods respected) | Table stakes across ERPs, FP&A and payroll APIs | INT-12 | M |
| 12 | **Embedded payroll (decide Check vs Gusto) + labor distribution to jobs** | Replaces QB Workforce; GL-accurate job cost (beats ServiceTitan's burden estimate) | PRL-04, task #32 | L |
| 13 | **Receipt capture by SMS/email + chase sender** | Bookkeeper time sink; Ramp/QBO parity | EXP-03/04/05 | M |
| 14 | **"Ask the client" loop** (transaction questions, document requests, magic link, carryover) | Replaces Double / Financial Cents add-ons for firm tenants | PRT-01/02 | M |
| 15 | **Scheduled report & lender packs + lender calendar + AI commentary** | Borrower-side white space; Fathom/Spotlight parity | RPT-08, DEBT-08/09 | S |
| 16 | **1099: IRS TIN matching + state filing via provider** | Cheap, visible January win; BILL/Ramp parity | TAX-05 | S |
| 17 | **Vendor bank-change freeze-until-verified + OFAC screening** | Fraud is the scariest AP risk; BILL's control is weak | PAY-04, VND-06 | S |
| 18 | **Commission & performance-pay engine with GL accrual** (owner to confirm it isn't the retired workforce engine) | HVAC/flooring comp is a monthly close pain; ingest ServiceTitan's file, compute for others | new; PRL | M |
| 19 | **3-statement forecast + consolidated budgets** | FP&A parity (Fathom/Reach/Spotlight) on our own ledger | FPA-08/15 | M |
| 20 | **COI depth**: requirement templates per job/vendor type, AI endorsement check, broker chase | Parity with myCOI/TrustLayer/Billy at pay-time | VND-02/04 | S |
| 21 | **Payment rails via licensed provider** (ACH/same-day, mailed checks, virtual card with rebate, positive pay) | Removes BILL/Melio from the stack; rebate offsets the subscription | PAY-05/07/09/11, INT-10 | L |
| 22 | **Multi-location inventory incl. trucks + replenishment proposals + consumption from field events** | HVAC/plumbing van stock; inventory tie-out per location | INV-04 | M |
| 23 | **Dealer pack**: serialized whole goods, floor-plan subledger, OEM warranty receivable, counter sales | Clive Power Equipment (Sage Intacct cancelled 10/1/2026, see 07 R1); nobody else does it in a modern GL | INV-04, AR-09, DEBT | L |
| 24 | **SSO/MFA/passkeys + SOC 2 readiness** | Gate for tenant #2 and firm resale | ADM-16 | M |
| 25 | **Public API + webhooks** (scoped, rate-limited, sandbox) | Partner ecosystem; pairs with MCP | new | M |

**Next 10 (after the top 25):**
- customer credit limits/holds + portal disputes
- consumer-financing accounting
- Excel add-in
- trades benchmarking
- exemption certificates + use tax + contractor taxability
- budget cycle + versions + headcount planning
- working papers + reviewer loop
- allowances/selections
- pay-when-paid linkage
- installer piece-rate payables

**Owner decisions surfaced by this research:**
- **(a)** The commission/performance-pay engine (#18) computes *earnings* for payroll and accrues them in the GL. It is
  not the retired workforce-chargeback/burden engine, but it touches "labor" and is canon-sensitive. Please confirm.
- **(b)** Payroll provider, Check vs Gusto (task #32):
  - **Check:** more flexible; construction partners (Miter/Trayd) for certified payroll; per-earning workers' comp codes; MCP.
  - **Gusto Embedded:** faster drop-in UI; a ready GL-by-job/department report; multi-company Payroll Digests.
- **(c)** Whether the dealer pack (#23) is go-live scope for Clive, given the Intacct cancellation date has passed (07 R1).
- **(d)** The bridge-lane ruling (07 §6 D2) gates #4.

---

## 7. Gaps in this research (follow-up pass, needs fresh search budget)

1. **Tax/COI vendors (all [U]):** confirm pricing and features for Avalara (AvaTax, ECM, 1099 & W-9), Tax1099, Zenwork,
   myCOI/illumend, Certificial, TrustLayer, Billy and Jones. In particular, confirm whether Billy or Jones can place an *actual* AP hold.
2. **RFMS** feature pages (commissions, installer pay, roll inventory, accounting modules) and **c-Systems Infinity** floor-plan
   and warranty modules.
3. **Procore Pay / Invoice Management**, JobTread, and the Jobber / Housecall Pro / FieldEdge feature pages (service plans,
   commissions, QBO sync).
4. **Spend tools:** SAP Concur Joule agents; Expensify / Navan / Emburse AI; Airbase after the Paylocity deal; Mercury and Rho
   pricing; Brex AI agents; the reported Capital One–Brex deal (single secondary source).
5. **Intuit Accountant Suite and Xero HQ** tiers and AI; Business Central consolidation / intercompany docs; Numeric primary site.
6. **Reddit sentiment** (r/Accounting, r/Bookkeeping, r/QuickBooks, r/HVAC, r/Construction): blocked this session.
7. **Benchmarks not obtained:** independent close-duration data (APQC), accounting-firm tool-count / tool-sprawl statistics,
   and verified 2026 US QBO list prices from Intuit.
8. **Recheck after Intuit Connect (Oct 26–28, 2026)**, especially IES Construction (retainage, lien waivers, AIA).
