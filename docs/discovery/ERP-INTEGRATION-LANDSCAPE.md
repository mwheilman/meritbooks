# MeritBooks — ERP / Field-Service Integration Landscape & Connector Architecture

**Owner:** Integration architect (discovery panel) · **Status:** Discovery/spec — no app code in this doc.
**Companion to:** `docs/discovery/INTEGRATION-MAP.md` (the external-systems layer as a whole).
**Task:** #138. Feeds #139 (connector framework + "connect your existing system" onboarding step).

---

## 0. The problem this solves

MeritBooks is the **book of record / general ledger** and native FP&A. It is *not* the operational
system a trade contractor runs the shop floor on. Our first-tenant portfolio alone (Heritage
Interiors, Crystal Kitchen & Bath, Iowa Custom Cabinets, Heartland/Dorrian/Metro HVAC, Clive Power
Equipment, Artistry Homes, …) runs a **zoo of vertical ERPs**: field-service dispatch, construction
PM, flooring/cabinet/millwork shop systems, roofing CRMs. Those systems own the *operational truth* —
customers, jobs/projects, estimates, work orders, invoices/AR, job costs/POs/AP, items, sometimes
payroll. MeritBooks needs to **pull the accounting-relevant slice of that truth into the GL** so the
customer keeps their operational ERP and still gets a real book of record + FP&A on top.

The Merit **Projects** module is our own operational ERP, but forcing a customer to switch to it is a
non-starter for onboarding. So the onboarding flow must offer: **"Connect your existing system"** →
pick your ERP → link it → we map and pull. The Merit Projects ERP is the *fallback* for customers who
don't have (or want to leave) a vertical system, not the on-ramp.

### The two data flows (do not conflate them)

This is the single most important framing, and it inherits directly from canon (`CANON-ANCHOR.md`
§1–2) and `INTEGRATION-MAP.md` §0:

| Flow | Source class | Direction | Cadence | GL relationship |
|---|---|---|---|---|
| **A. Operational pull** | Trade/field-service **ERPs** (ServiceTitan, Buildertrend, RFMS, Innergy, JobNimbus …) | ERP → Books, **read-only** | **Live / ongoing** (webhook + poll) | ERP owns ops; Books derives GL postings + AR/AP subledgers from ERP objects. Never write ops back. |
| **B. Accounting migration** | **Accounting systems** (QuickBooks, Xero, Sage 50/Intacct, NetSuite) | Accounting → Books, **read-only** | **One-time** (with a short re-pull window) | Historical trial balance + master data import. **After cutover Books is authoritative; no sync-back, ever.** |

Everything below respects three canon invariants: **(1)** Books OWNS the ledger — we never push
journal entries *to* QuickBooks/ServiceTitan; **(2)** Books owns the *ledger*, not the business
objects — an inbound customer/vendor/item/job writes `core`-schema master data referenced by FK, not
a Books-private copy; **(3)** every AI seam (entity resolution, categorization, field mapping
suggestions) routes through `@meritbooks/core-ai`, never a module-held key.

---

## 1. What "accounting-relevant" means (the target object model)

For every source system we care about the same small set of objects, because these are what a GL and
its subledgers are built from. This is the **canonical target** every connector maps *into*:

| Books/`core` target | Trade-ERP source objects (typical names) | Becomes, in Books |
|---|---|---|
| **Customer** | Customer / Client / Account | `core.customers` (AR party) |
| **Job / Project** | Job / Project / Opportunity / Work Order | job-cost dimension + `core` project |
| **Invoice (AR)** | Invoice / Requisition / Progress Bill | AR invoice → revenue + `1200 A/R` post |
| **Payment / Receipt** | Payment / Deposit / Applied Receipt | cash application → AR relief |
| **Estimate / Contract value** | Estimate / Quote / Bid / Contract | budget baseline for job costing / rev-rec |
| **Vendor / Sub** | Vendor / Supplier / Subcontractor | `core.vendors` (AP party) |
| **Bill / Cost (AP)** | Bill / PO / Commitment / Sub-invoice / Purchase | AP bill → expense/WIP + `2000 A/P` post |
| **Item / Pricebook** | Item / SKU / Pricebook / Cost code | `core.items` + cost-code dimension |
| **Time / Labor cost** | Timesheet / Labor entry | job-cost labor (cost only — hours live in PM module) |
| **Payroll** | Payroll register (often external: Gusto/ADP) | payroll JE (via Finch/register import, not the trade ERP) |

The connector's job is **object mapping + normalization + idempotent upsert into `core`/subledgers**,
then handing balanced postings to the existing GL posting engine. It is *data entry at machine scale*
— identical safety posture to the AP intake pipeline (`apps/web/src/lib/ap/intake.ts`): imported
records land as **drafts/proposed postings**, low-confidence maps land for human review, nothing
auto-posts money without the existing approval flow.

---

## 2. The systems landscape

Legend — **API**: public REST/GraphQL with OAuth or API-key. **WH**: webhooks for near-real-time
push. **CSV**: sanctioned file export path. **Aggr**: reachable today via a unified-API aggregator
(Merge/Codat/Rutter/Finch). **Gate**: partner-program / approval / plan-tier gate to get production
API access. **Objects**: which accounting-relevant objects it exposes (C=customer, J=job/project,
I=invoice/AR, P=payment, E=estimate, V=vendor, B=bill/cost/PO, It=item/pricebook, Pr=payroll).

### 2A. Field service — HVAC / plumbing / electrical / mechanical (highest-priority vertical for Merit)

| System | Vertical | API | WH | CSV | Aggr | Gate | Objects | Notes |
|---|---|---|---|---|---|---|---|---|
| **ServiceTitan** | HVAC/plumb/elec, commercial trades | ✅ REST v2, OAuth2 client-credentials + per-app App Key | ✅ | ✅ | Codat (commerce/field), some via Merge | **High** — developer portal app review; tenant must grant | C J I P E V B It Pr | The 800-lb gorilla; dedicated **Accounting API** (invoices, payments, inventory bills, payroll export). Tier-1 native target. |
| **Housecall Pro** | Home services (HVAC/plumb/elec/clean) | ✅ Public API | ✅ (MAX plan only) | ✅ | Partial | Med — webhooks gated to MAX plan | C J I P E V(ltd) It | Jobs, customers, invoices, estimates, employees, payments. Clean REST. |
| **ServiceTrade** | Commercial HVAC/mechanical/fire | ✅ REST API | ✅ | ✅ | — | Med | C J I P E V B | Strong for commercial service+projects; good invoice/job cost surface. |
| **FieldEdge** | HVAC/plumb/elec | Ltd/partner API | ~ | ✅ | — | High — QuickBooks-centric | C J I P It | Deeply QuickBooks-integrated; may be easier to reach via its QBO sync than its own API. |
| **Service Fusion** | HVAC/plumb/elec/roofing | ✅ API | ~ | ✅ | Partial | Med | C J I P E V It | Jobs, customers, estimates, invoices, techs, dispatch inventory. |
| **Workiz** | Field service SMB | ✅ REST API + webhooks | ✅ | ✅ | — | Low/Med | C J I P | Smaller shops; decent API. |
| **BuildOps** | Commercial mechanical/service+projects | ✅ Dev Center API | ✅ | ✅ | — | Med/High | C J I P E V B It | Service agreements, projects, quoting, invoicing. Modern API. |
| **Aspire** | Landscaping (commercial) | ✅ API (ServiceTitan-owned) | ~ | ✅ | — | Med/High | C J I P E V B It | Owned by ServiceTitan; job-costing depth. |
| **mHelpDesk** | Field service SMB | Ltd API | — | ✅ | — | Med | C J I P | Older; CSV likely the realistic path. |
| **Kickserv** | Field service SMB | ✅ API | ~ | ✅ | — | Low | C J I P E | QuickBooks-oriented SMB tool. |

### 2B. Construction — homebuilding / remodel / GC / PM

| System | Vertical | API | WH | CSV | Aggr | Gate | Objects | Notes |
|---|---|---|---|---|---|---|---|---|
| **Procore** | GC / commercial construction | ✅ REST, OAuth2, App Marketplace | ✅ | ✅ | — | **High** — Marketplace review + ERP-connector program | C J I(requisitions) P E V B(commitments/COs) It | Rich financial tools API: budgets, commitments, subcontractor invoices, change orders, direct costs. Tier-1 native for GC customers. |
| **Buildertrend** | Homebuild / remodel | Partner API (not broadly public), bidirectional | ~ | ✅ | — | **High** — partner-gated; QBO-native | C J I P E B | API exists for partners (projects, schedules, payments, docs); public availability limited → CSV/partner path near-term. |
| **CoConstruct** | Custom build / remodel | ✅ API (now folding into Buildertrend) | ~ | ✅ | — | Med | C J I P E B | Merged with Buildertrend; treat as Buildertrend family. |
| **JobTread** | GC / remodel | ✅ **Open API** | ✅ | ✅ | — | Low | C J I P E V B It | Explicitly markets an open API "connect to any tool." Good early native target for the SMB build segment. |
| **Knowify** | Trade contractor / GC | ✅ API | ~ | ✅ | — | Med | C J I P E V B It | QBO-integrated job costing + AIA billing; solid object surface. |
| **Contractor Foreman** | SMB GC/trades | Ltd API / Zapier | ~ | ✅ | Zapier | Med | C J I P E V B | Affordability play; realistic path = CSV/Zapier near-term. |
| **Buildxact** | Custom build / remodel estimating | ✅ API (developer portal, keys) | ~ | ✅ | — | Low/Med | C J E B It | Estimating-forward; has a real dev portal. |
| **Houzz Pro** | Remodel / design-build | ✗ weak/limited export; low API grade | — | Ltd | — | High | C J E(ltd) | Poor programmatic access → **CSV/manual** or defer. |

### 2C. Roofing / exteriors

| System | Vertical | API | WH | CSV | Aggr | Gate | Objects | Notes |
|---|---|---|---|---|---|---|---|---|
| **JobNimbus** | Roofing/exteriors CRM | ✅ **Open API** + native webhooks | ✅ | ✅ | Zapier/Make | Low | C J I P E | Well-documented open API; easy early native target for roofing. |
| **AccuLynx** | Roofing | ✅ API (developer-oriented) | ~ | ✅ | — | Med | C J I P E V B It | Deep supplier + accounting integration; job costing. |
| **Roofr** | Roofing (measure→estimate→invoice) | Ltd/growing API | ~ | ✅ | — | Med | C J I E | Pre-sale measurement + job costing expanding. |
| **Leap** | Exteriors (estimate/contract) | Partner API | — | ✅ | — | Med | C J E | Estimating/contracts; CSV realistic near-term. |
| **MarketSharp** | Remodel/exteriors CRM | Ltd API | — | ✅ | — | High | C J E P | Older CRM; CSV path. |
| **Dataforma** | Commercial roofing service | Ltd API | — | ✅ | — | High | C J I P V B | Service+asset management; CSV path. |

### 2D. Flooring / cabinetry / millwork (Merit-relevant: Heritage, Crystal K&B, Iowa Custom Cabinets, Revived)

| System | Vertical | API | WH | CSV | Aggr | Gate | Objects | Notes |
|---|---|---|---|---|---|---|---|---|
| **RFMS** | Flooring dealer ERP | ✅ **API** + Zapier | ~ | ✅ | Zapier | Med | C J I P E V B It | Publishes to API + Zapier; strong flooring-dealer object model. Tier-1/2 native for flooring. |
| **QFloors / QPro** | Flooring dealer | Ltd API; **QBO integration** native | — | ✅ | via QBO | Med | C J I P V B It | Cloud QPro syncs to QuickBooks Online → reach it via **QBO (Codat/Merge)** rather than its own API. |
| **RollMaster (Broadlume)** | Flooring dealer ERP | Ltd/partner API; QBO/Xero integrations | — | ✅ | via QBO/Xero | Med/High | C J I P V B It | Broadlume-owned; accounting via QBO/Xero bridge. |
| **Comp-U-Floor / CompuSystems (Broadlume)** | Flooring/cabinet dealer ERP | Ltd/partner API; QBO integration | — | ✅ | via QBO | Med/High | C J I P V B It | Owner-named. Realistic path: QBO bridge + CSV. |
| **Measure Square** | Flooring/tile measure+estimate | ✅ **Cloud API** | ~ | ✅ | — | Low/Med | J E It | Measurement/estimate exchange; feeds estimate→budget, not full AR. |
| **Pacific Solutions / FloorRight** | Flooring estimating/ERP | Ltd API | — | ✅ | — | Med | J E B It | Estimating-forward; CSV path. |
| **Innergy** | Architectural millwork ERP | Ltd/partner API; syncs job cost+revenue to accounting | ~ | ✅ | — | Med/High | C J I(progress) P E V B It | Owner-named. Millwork niche leader; integrates BOM→purchasing→accounting. Native (partner) or CSV. |
| **Cabinet Vision (CV)** | Cabinet CAD/CAM | ✗ design tool (BOM export) | — | ✅ | — | — | E(BOM) It | Design/BOM only; feeds estimate/items, not AR/AP. CSV/manual. |
| **Microvellum** | Millwork CAD/CAM | ✗ design tool (BOM export) | — | ✅ | — | — | E(BOM) It | Same as CV — BOM/estimate feed only. |
| **Allmoxy** | Cabinet-shop order mgmt | Ltd API; **CSV** export to partners | — | ✅ | — | Med | C J I E It | CSV export is the documented path (e.g. to Mozaik). |
| **Mozaik** | Cabinet design/production | ✗ design + CSV import | — | ✅ | — | — | E(BOM) It | Consumes CSV; not an accounting source. |

### 2E. Mid-market / enterprise construction ERPs (often *are* the accounting system → treat as Flow B where they own the GL)

| System | Vertical | API | WH | CSV | Aggr | Gate | Objects | Notes |
|---|---|---|---|---|---|---|---|---|
| **Sage Intacct (Construction)** | Cloud construction financials | ✅ REST/XML web services (SOAP-era + REST) | ~ | ✅ | Codat, Merge, Rutter | Med | C J I P V B It (+GL) | Often the incumbent *GL*. Import as Flow B (trial balance + master data), or live-read via Codat/Merge. |
| **Sage 300 CRE (Timberline)** | Construction ERP | Ltd SDK/API (on-prem) | — | ✅ | via connectors | High | C J I P V B It (+GL) | On-prem; realistic path = CSV/ODBC export or a Sage connector. |
| **Sage 100 Contractor** | SMB construction ERP | Ltd API | — | ✅ | — | High | C J I P V B It (+GL) | CSV/export path realistic. |
| **Foundation Software** | Construction accounting/payroll | Ltd API/partner | — | ✅ | — | High | C J I P V B It Pr (+GL) | Job-cost + construction payroll; CSV/partner path. |
| **Viewpoint Vista / Spectrum (Trimble)** | Enterprise construction ERP | ✅ API + connectors | ~ | ✅ | — | High | C J I P V B It (+GL) | Vista (on-prem-first) + Spectrum (cloud) both expose APIs/connectors. |
| **CMiC** | Enterprise construction ERP | ✅ REST API | ~ | ✅ | — | High | C J I P V B It (+GL) | Enterprise GC; API + integration services. |
| **Acumatica (Construction Edition)** | Cloud construction ERP | ✅ **Robust REST/contract API** | ✅ | ✅ | — | Med | C J I P V B It (+GL) | Modern cloud ERP; excellent API. If incumbent GL → Flow B; else live-read. |
| **NetSuite** | Cloud ERP (some contractors) | ✅ SuiteTalk REST/SOAP | ~ | ✅ | Codat, Merge, Rutter | Med | C J I P V B It (+GL) | Reach via aggregator (Codat/Merge) — well covered. |

### 2F. Generic PM / ops + accounting *migration sources*

| System | Role | API | WH | CSV | Aggr | Gate | Objects | Notes |
|---|---|---|---|---|---|---|---|---|
| **Jobber** | Field-service SMB (all trades) | ✅ **GraphQL API**, OAuth2, HMAC webhooks | ✅ | ✅ | — | Low/Med | C J I P E V(ltd) It | Owner-named. Clean GraphQL; clients→invoices→payments. Strong Tier-1 native for SMB trades. |
| **ClickUp** | Generic PM/ops | ✅ REST API + webhooks | ✅ | ✅ | Merge (ticketing/PM) | Low | J(tasks) E(custom) | Owner-named. Not an accounting system — jobs/tasks + custom fields only; maps to job/project dimension, weak AR/AP. |
| **Monday.com** | Generic PM/ops | ✅ REST/GraphQL + webhooks | ✅ | ✅ | Merge | Low | J(items) | Same as ClickUp: project dimension feed, not AR/AP. |
| **QuickBooks Online** | **Accounting migration source** | ✅ REST, OAuth2 | ✅ | ✅ | **Codat, Merge, Rutter** | Low | C J I P V B It +GL | Flow B one-time import. Best reached via **aggregator** (covers QBO+Desktop+Xero at once). |
| **QuickBooks Desktop** | Accounting migration source | via QBWC/aggregator | — | ✅ (IIF/CSV) | **Codat, Merge** | Med | C J I P V B It +GL | Aggregators handle the Desktop Web Connector pain for us. |
| **Xero** | Accounting migration source | ✅ REST, OAuth2 | ✅ | ✅ | **Codat, Merge, Rutter** | Low | C J I P V B It +GL | Flow B; aggregator-covered. |

### 2G. Aggregators / unified APIs (the force multiplier)

| Aggregator | Covers | Shape | Fit for MeritBooks |
|---|---|---|---|
| **Codat** | Accounting (QBO/Desktop/Xero/Sage/Intacct/NetSuite/FreeAgent…), commerce, banking; **construction/field via commerce+accounting**; explicitly targets fintech book-of-record use cases | Read **and** write, normalized accounting model, sync + webhooks | **Primary aggregator.** Best-shaped for *accounting* objects and construction-adjacent sources; built for exactly our "read customers' accounting data into a fintech ledger" job. Tier-2 anchor. |
| **Merge.dev** | 200+ integrations incl. **30+ accounting/ERP** (QBO/Xero/NetSuite/Intacct/Sage), plus HRIS/ticketing/CRM/file | One unified API, normalized "Common Models," webhooks + polling | Strong alternate/second aggregator, esp. if we also want HRIS/CRM later. Broad but shallower per-object than Codat on accounting. |
| **Rutter** | Commerce + **accounting** (QBO/Xero/Sage/NetSuite) + payments | Unified read/write | Good accounting coverage; commerce-leaning. Backup to Codat. |
| **Finch** | **Payroll/HRIS** — 250+ (Gusto, ADP Run/Workforce Now, Paychex, QuickBooks Payroll, Rippling, UKG, isolved…) | Unified read, normalized employment/pay data | **The payroll answer.** Trade ERPs rarely own payroll; Finch pulls the payroll register for the payroll JE regardless of provider. |
| **Apideck** | Accounting + HRIS + CRM + file unified | Unified API | Alternate to Merge; evaluate on price/coverage only if Codat+Merge gaps appear. |

**Coverage takeaway:** a single **Codat** integration reaches essentially every *accounting* migration
source (QBO/Desktop/Xero/Sage/Intacct/NetSuite) **and** several construction/field systems' accounting
layers. A single **Finch** integration reaches essentially every *payroll* provider. Between them, two
connectors retire the bulk of Flow B and all of payroll. The trade ERPs' *operational* objects (jobs,
estimates, work orders, commitments) are where native connectors still earn their keep.

---

## 3. Recommended architecture — a provider-agnostic connector framework

Mirror the two patterns already proven in the codebase:

1. **The capability-adapter boundary** used for money movement
   (`apps/web/src/lib/money/providers/types.ts`: one interface per capability, many concrete
   adapters). We add a new capability family: **`ERP_INGEST`**.
2. **The AP intake safety posture** (`apps/web/src/lib/ap/intake.ts`): imports are machine *data
   entry*, land as drafts/proposed postings, low-confidence maps go to a human, nothing moves money
   without the existing approval flow.

### 3.1 The connector interface (one per source system, method-tagged)

```
ConnectorMethod =
  | 'NATIVE_API'    // OAuth2 / API-key direct to the ERP (ServiceTitan, Jobber, JobNimbus, Procore…)
  | 'AGGREGATOR'    // one Merit integration → many ERPs (Codat / Merge / Rutter / Finch)
  | 'WEBHOOK'       // ERP pushes near-real-time events we subscribe to (usually rides on NATIVE_API)
  | 'CSV_IMPORT'    // sanctioned file/export path (drop-and-parse, reuses doc-intelligence)
  | 'MANUAL'        // guided manual entry / spreadsheet template (long-tail + design-only tools)

interface ErpConnector {
  key: string;                 // 'servicetitan' | 'codat:quickbooks' | 'rfms' ...
  method: ConnectorMethod;
  vertical: string;
  flow: 'OPERATIONAL_PULL' | 'ACCOUNTING_MIGRATION';
  capabilities: ErpObject[];   // which of C/J/I/P/E/V/B/It/Pr it can supply
  authenticate(ctx): Promise<ConnectionHandle>;   // OAuth handshake or key store (opaque handle only)
  listSince(handle, cursor): AsyncIterable<RawRecord>;   // incremental pull
  onWebhook?(event): Promise<RawRecord[]>;        // if method includes WEBHOOK
  map(raw): ProposedUpsert;    // ERP object → core/subledger canonical shape (AI-assisted, confidence-scored)
}
```

Every connector normalizes into **one canonical intake queue** (reuse the AP intake-queue idea:
`apps/web/src/lib/ap/doc-intelligence/intake-queue.ts`). The queue does entity resolution
(dedupe customer/vendor/item against `core`), confidence-tiers each mapping (reuse `score-tier`),
and hands **balanced proposed postings** to the existing GL engine. High-confidence records upsert
silently; low-confidence land in a **field-mapping review UI** for a human. **Read-only always** — no
connector ever writes back to the source ERP.

### 3.2 Data-mapping model (their objects → MeritBooks)

- **Customer/Vendor/Item** → resolve-or-create in `core` (never a Books-private copy), keyed by an
  `external_ref` (source system + source id) so re-pulls are idempotent upserts, not duplicates.
- **Job/Project** → job-cost dimension + `core` project; the source job id is the durable key that all
  costs/invoices hang off.
- **Invoice (AR)** → AR subledger invoice → post revenue + `1200 A/R`; **Payment** → cash application.
- **Bill/PO/Commitment (AP)** → AP subledger bill → expense/WIP + `2000 A/P`; runs through the same
  human approval flow as AP intake (nothing auto-approves a payable).
- **Estimate/Contract** → job budget baseline (drives cost-to-complete / WIP over-under billing, which
  already exist) and rev-rec method selection captured at onboarding.
- **Payroll** → **not** from the trade ERP; pull the register via **Finch** (or register-drop import,
  which already exists) → payroll JE.
- **Idempotency + provenance:** every imported row carries `(connector_key, external_id, external_updated_at)`;
  a unique index on `(org_id, connector_key, external_id)` makes re-pulls and overlapping
  webhook+poll safe (same discipline as the payment double-post unique indexes, migration 064).

### 3.3 Onboarding UX ("connect your existing system")

Onboarding wizard gains a step: **"How do you run jobs today?"** → search/pick from a catalog of the
systems in §2 → branch by that connector's `method`:
- **NATIVE_API / AGGREGATOR:** OAuth handshake (or aggregator link flow) → we pull a preview → user
  confirms the field mapping → background sync starts.
- **CSV_IMPORT:** show the drop-and-parse uploader (reuse doc-intelligence) with a per-system template.
- **MANUAL / design-only tool:** offer the guided spreadsheet template, or route them to **Merit
  Projects** as the operational fallback.
- **"My accounting is in QuickBooks/Xero/Sage":** the Flow-B one-time migration path (Codat/Merge),
  which is the historical-conversion pipeline that already exists (task #49) — now aggregator-backed.

---

## 4. Recommended tiered rollout

**Tier 1 — Native connectors (build first, direct API).** The systems that (a) have clean public
OAuth APIs, (b) own operational objects an aggregator won't give us, and (c) match Merit's own
verticals. In priority order:

1. **ServiceTitan** — the trades gorilla; dedicated Accounting API; matches Heartland/Dorrian/Metro HVAC.
2. **Jobber** — clean GraphQL + webhooks; broad SMB-trades coverage.
3. **JobNimbus** — open API + webhooks; roofing/exteriors.
4. **Procore** — GC financials API (budgets/commitments/requisitions/COs); matches Artistry Homes-class GC.
5. **RFMS** — flooring-dealer API; matches Heritage Interiors / flooring segment.
6. *(fast-follow within Tier 1)* **JobTread**, **Housecall Pro**, **Knowify**, **AccuLynx**, **ServiceTrade**,
   **Innergy** (partner API) — all have real APIs and hit Merit-relevant trades.

**Tier 2 — Aggregators (one integration, many systems).** Stand up **Codat** (accounting + construction-
adjacent) and **Finch** (payroll) as the workhorses. This single wave retires the entire **Flow-B
accounting-migration** long tail (QuickBooks Online/Desktop, Xero, Sage 50/300/Intacct, NetSuite) and
all payroll providers, and picks up NetSuite/Intacct-based contractors "for free." Add **Merge** as an
alternate if we later want HRIS/CRM breadth. Sequence Codat *before* deep native work on any system it
already covers well (NetSuite, Intacct, QBO-bridged flooring tools like QFloors/RollMaster/Comp-U-Floor).

**Tier 3 — CSV import + manual (the long tail).** For everything partner-gated, on-prem, weak-API, or
design-only: Buildertrend (until partner API), Contractor Foreman, Houzz Pro, Sage 300 CRE/100
Contractor, Foundation, Comp-U-Floor/RollMaster (direct), Measure Square/Cabinet Vision/Microvellum/
Mozaik/Allmoxy (BOM/estimate feeds). Reuse the existing drop-and-parse doc-intelligence pipeline with
per-system column templates. This guarantees **every** customer can onboard on day one even if their
system has no API — CSV is the universal floor; Merit Projects is the operational fallback.

### Why this order covers the most ground fastest

- **Codat + Finch (2 integrations)** eliminate the bulk of accounting-migration and *all* payroll work
  — the highest leverage per unit of build.
- **5 native connectors** cover Merit's own portfolio verticals (HVAC, GC, roofing, flooring) with the
  operational depth aggregators can't supply.
- **CSV** removes "no API" as a blocker for the several dozen long-tail systems, so onboarding never
  hard-stops.
- Net: **~3 build waves** (aggregator wave, top-5 native wave, CSV framework) put a "connect your
  existing system" step in onboarding that meaningfully covers the whole landscape in §2.

---

## 5. Risks / gates to flag for Mike

- **Partner-program gates are real.** ServiceTitan, Procore, and Buildertrend all require app review /
  partner approval and a *customer-granted* connection; budget lead time. JobTread/JobNimbus/Jobber are
  low-friction and good to prove the framework on first.
- **Buildertrend has no broadly public API** today — Tier-3 (CSV/partner) until that changes, despite
  its popularity in remodel.
- **Design/CAD tools (Cabinet Vision, Microvellum, Mozaik) are not accounting sources** — they feed
  BOM/estimate/items only; don't over-invest in them as GL inputs.
- **QBO-bridged flooring ERPs** (QFloors, RollMaster, Comp-U-Floor) are often *cheapest reached through
  their QuickBooks bridge via Codat* rather than their own thin APIs — validate per customer.
- **Read-only, one-way, forever** for operational ERPs; **one-time only** for accounting migration.
  Never let a connector become a write-back path — that violates the book-of-record invariant.

---

## 6. Sources

- ServiceTitan developer portal & Accounting API — https://developer-next.servicetitan.io/docs/overview/ ; https://www.servicetitan.com/api/
- Jobber Developer Center (GraphQL, OAuth2, webhooks) — https://developer.getjobber.com/docs/
- Housecall Pro Public API — https://docs.housecallpro.com/ ; https://help.housecallpro.com/en/articles/8505035-api-overview
- Procore financial tools & webhooks API — https://developers.procore.com/documentation/tutorial-financial-tools ; https://procore.github.io/documentation/webhooks-api
- JobTread open API — https://www.jobtread.com/ ; JobNimbus API — https://supergood.ai/api-report-card/jobnimbus ; AccuLynx integrations — https://acculynx.com/integrations/
- Buildxact developer portal — https://developer.buildxact.com/ ; BuildOps Dev Center — https://developer.buildops.com/ ; CoConstruct developers — https://www.coconstruct.com/developers ; Aspire — https://apitracker.io/a/youraspire
- Buildertrend API (partner) — https://supergood.ai/docs/buildertrend-api ; https://buildertrend.com/blog/blog-construction-api/
- Flooring software (RFMS API+Zapier, QFloors QBO, RollMaster/Comp-U-Floor, Measure Square Cloud API) — https://www.fcnews.net/2020/09/system-integration-connects-the-dots/ ; https://www.qfloors.com/news/qfloors-quickbooks-integration.html
- Innergy millwork ERP + Microvellum/accounting sync — https://www.innergy.com/ ; https://www.microvellum.com/resources/news/why-millwork-manufacturers-are-turning-to-erp ; Allmoxy CSV — https://articles.allmoxy.com/connecting-allmoxy-to-industry-partner-software
- Construction ERPs (Sage Intacct/300 CRE, Viewpoint Vista/Spectrum, Foundation, Acumatica, CMiC) — https://ascentconsults.com/construction-erp-software-showdown/
- Codat accounting integrations — https://docs.codat.io/integrations/accounting/overview ; https://codat.io/industries/fintech/
- Merge accounting unified API — https://docs.merge.dev/merge-unified/accounting/overview ; https://www.merge.dev/blog/accounting-api
- Finch payroll/HRIS unified API — https://www.tryfinch.com/finch-api ; https://www.tryfinch.com/blog/best-unified-apis-hris-payroll ; Rutter — referenced via unified-API comparisons
