# MeritBooks — Integrations Plan (field systems, ERPs, spend, payroll, aggregators)

**Status:** plan / reference · authored 2026-10-18 · read-only research (no code or schema changed).
**Owner ask:** "it needs to link to major ERPs, ServiceTitan, Buildertrend, Innergy, simPRO, RFMS, C-Systems, and as many
ERPs we can integrate with the better."
**Canon this plan must obey** (`docs/canon/CANON-ANCHOR.md`, `10-suite-contracts-digest.md`): MeritBooks **owns the GL**;
QBO/Sage/Xero are **one-time migration sources**; Books does **not** own Customer/Vendor/Item/Employee (Core does); invoice #,
bill #, JE # are **minted by Books**; posted AR is **never edited in place**; every cross-module financial event respects
`fiscal_periods` (closed → rejected); provider secrets live in Vault, rows hold a `secret_ref` only; webhooks go through the
**Core verify-and-route**; payroll/bank PII **never** lands in an app table; reference GL accounts **by role, not number**.

**Evidence tags used below:** **[P]** vendor's own docs/site · **[3P]** third-party (integrator, aggregator, wrapper, blog) — treat
as a lead to confirm · **[R]** this repo · **[IR]** Merit tech-stack record (`merit-business-context/references/tech-stack.md`,
sourced from `Merit Tech Stack Diagram.xlsx`) · **[J]** my engineering judgment (efforts, priorities).

---

## 0. Summary

### 0.1 What Merit's companies actually run (this changes the priority order)

The Merit tech-stack record [IR] lists 8 of 15 entities; the other 7 are blank or missing (**[gap]**):

| Entity | Job / field system | Books today | Read-out |
|---|---|---|---|
| Heartland Heating & Cooling | **simPRO** | QuickBooks | HVAC on **simPRO**, not ServiceTitan |
| Dorrian Heating & Cooling | **FieldEdge** | QuickBooks | HVAC on **FieldEdge**, which the owner's list leaves out |
| Metro Heating & Cooling | **[gap]** (not in the diagram) | [gap] | The only HVAC entity that *could* be on ServiceTitan, and that's unconfirmed |
| Iowa Custom Cabinetry | **Innergy** | QuickBooks | Cabinets/millwork |
| Heritage Interiors | **RFMS** (hosted) + Sage + QBTime | QuickBooks | Flooring. The most complex single-entity stack |
| AIM Kitchen & Bath | **Buildertrend** | QuickBooks | Kitchen & bath runs **Buildertrend**, not RFMS |
| Revived Interiors | **Buildertrend** | [gap] | |
| Clive Power Equipment | **c-Systems (Infinity DMS)** | **Sage Intacct, cancelled effective 10/1/2026** | ⚠ That date has **already passed** (today is 10/18/2026). See §5 R1 |
| Crystal K&B, MMG, Swan Creek, Artistry Homes, Wild Rose, SPE 5 | [gap] | [gap] | Mike needs to fill these in before Phase 1 is final |

**Two corrections to the brief.** (a) No Merit entity is confirmed on ServiceTitan. ServiceTitan is still the most important
system for the *market* (other tenants and accounting firms), but for Merit's go-live, **simPRO and FieldEdge** carry the HVAC
volume. (b) **"C-Systems" = c-Systems Software Inc.**, maker of the **Infinity** dealer-management system for outdoor power
equipment / ag / powersports dealers. It is based in Arlington TX and owned by Constellation Software (Perseus) since 2018
([P] [csystemssoftware KB](https://customer.csystemssoftware.com/tag/infinity-dealer-management-system/), [3P]
[Rural Lifestyle Dealer](https://www.rurallifestyledealer.com/articles/c-systems-offers-automated-stihl-product-registration),
[Constellation acquisition](https://constellationdealer.com/?p=1307)). I confirmed it two ways: Clive Power Equipment is a
power-equipment dealer, and [IR] lists "Clive → C-Systems". It is **not** the flooring "Comp-U-Floor/CompuSystems" product,
which the catalog has as `compufloor`.

### 0.2 Honest API reality of the six named systems

| System | Public API? | Path to production for a 3rd-party SaaS | Verdict |
|---|---|---|---|
| **ServiceTitan** | Yes, REST, rich | **Certified-app partner program** (application, certification, annual dues + per-connection fee or rev-share). **Tunneling is prohibited**: we may not ask a tenant to create an App Key and share it with us ([P] [ServiceTitan integration paths](https://help.servicetitan.com/docs/understand-approved-integration-paths-in-servicetitan), [P] [Program Guide](https://www.servicetitan.com/legal/app-marketplace-program-guide)) | Workable. Fastest legal route: **Agave**, an already-certified ST app. Apply to ST in parallel |
| **simPRO** | Yes, REST + OAuth2 + webhooks ([P] [Simpro Developer Center](https://developer.simprogroup.com/apidoc/)) | **Single-build OAuth app** the customer creates (works today). **Central partner app** after partner agreement + integration approval ([3P] [Nango guide](https://nango.dev/docs/api-integrations/simpro/how-to-register-your-own-simpro-api-oauth-app.md)) | **Best API of the six.** Build direct |
| **RFMS** | Yes, REST, Basic-auth session, tiered by the *customer's* API subscription ([P] [RFMS API](https://rfms.com/solutions/api)) | Customer buys the API tier (Standard / Plus / Enterprise) | Workable. **No GL/AP endpoints, no webhooks found.** Poll |
| **Buildertrend** | **No public/self-serve API.** Partner agreement only ([3P] [Supergood report card](https://supergood.ai/api-report-card/buildertrend), [3P] [Bolder Apps](https://www.bolderapps.com/blog-posts/buildertrend-integration-custom-construction-apps-2026)) | Business-development conversation. Native syncs exist to QBO, Xero and Sage Intacct (new 6/30/2026) ([P] [BT × Sage Intacct](https://buildertrend.com/integration/sage-intacct/)) | **Blocked on partnership.** Interim: bridge mode (§3.2) |
| **Innergy** | **No public API found.** Integrates natively with Sage, QuickBooks, NetSuite; "additional integrations on request" ([P] [Innergy FAQ](https://www.innergy.com/faq/)) | Ask Innergy | **Blocked.** Interim: bridge + Excel exports |
| **c-Systems Infinity** | **No public API found.** Infinity has its **own GL**: every transaction posts Dr/Cr via a GL Interface Wizard ([P] [Infinity KB](https://infinity.csystemssoftware.com/knowledgeBase/17308915)). It also has a **QuickBooks Interface** ([P] [c-Systems announcements](https://customer.csystemssoftware.com/announcements/)) | Ask c-Systems / Constellation | **Blocked.** Interim: GL/financial-statement export file, or bridge |

### 0.3 The big architectural call

Almost every one of these systems **already pushes accounting data into QuickBooks Online.** ServiceTitan, Buildertrend,
Innergy, simPRO, FieldEdge, Housecall Pro, Jobber and c-Systems all do. MeritBooks already has a **real, tested QBO OAuth
connector** [R]. So Phase 1 gets **two lanes**:

1. **Direct lane** for systems with a workable API: Ramp, Plaid, simPRO, RFMS, ServiceTitan (via Agave → later certified).
2. **Bridge lane** for systems with no API: Buildertrend, Innergy, c-Systems, FieldEdge until partner access lands. The field
   system keeps syncing into the entity's existing QBO company, and MeritBooks pulls those transactions daily through the QBO
   connector. QBO stays a **transport, not the book of record**. This is a canon-sensitive choice and needs Mike's ruling
   (§6 D2).

---

## 1. Integration architecture

### 1.1 What exists today [R]

| Piece | Where | State |
|---|---|---|
| Connector **catalog** (≈25 systems; Connect UI branches on `connectionMethod`) | `apps/web/src/lib/integrations/erp/catalog.ts` | Catalog only. **Missing Merit's own systems: simPRO, FieldEdge, c-Systems.** Also missing Ramp, Sage Intacct (as distinct from "Sage"), NetSuite and Successware |
| Data-connection **registry** `core.erp_connections` (org, erp_id, method, status, label, meta, connected/last_sync) | mig `108_erp_connections.sql` | Live. **Unique index `(org_id, erp_id)` permits only one connection per system per org.** That blocks Merit's 10+ QBO companies and any org with two ServiceTitan tenants |
| Money-provider registry `core.provider_connections` (capability ∈ AR_COLLECTION / AP_DISBURSEMENT / PAYROLL / BANK_FEED) + **Vault** secrets | mig `041`, `lib/money/connections.ts`, `lib/money/secrets.ts` | Live (Stripe test, Plaid sandbox) |
| **QBO OAuth** reference implementation: authorize URL, code exchange, refresh **with rotation**, single-flight refresh, revoke, Vault-backed token store, plain-English errors, degrade-safe selection (live / mock / not_connected / sample_blocked) | `erp/quickbooks/{oauth,token-manager,connection-store,client,live-source,transforms,preflight}.ts`; routes `api/integrations/erp/quickbooks/{connect,callback,status,pull,disconnect}` | **Real.** This is the pattern to copy |
| Migration provider interface (`ConnectorProvider`: accounts / customers / vendors / open AR / open AP / TB) + deterministic **mapping profiles** + conversion adapter into `/api/onboarding/conversion` | `erp/providers/*` | Live for the QBO path; Xero/Sage mock only |
| Plaid incremental sync **cursor** pattern (`sync_cursor` on the item row) | mig `046_plaid_bank_feed.sql` | Live (sandbox) |
| External-ref idempotency: `gl_entries.source_ref` + **unique `(org_id, source_ref, entry_type)`** | mig `056`, `064` | Live. Reuse it for connector postings |
| Exceptions surface `ai_decisions → /exceptions` (EC-1 duplicate payment, EC-4 uncategorized, etc.) | mig `039` + detectors | Live |
| Scheduler / cron | INT-01 | **Not built.** A hard prerequisite for any sync |

### 1.2 Layered connector framework (target)

```
 Catalog row ──► Connect flow ──► Credential vault ──► Sync engine ──► Staging ──► Mapper ──► Posting ──► GL
 (catalog.ts)    (per strategy)    (Vault secret_ref)   (cursor/webhook/   (raw,    (profile +   (core.events →   (gl-posting,
                                                         backfill/sweep)    hashed)   approved     Books typed      source_ref
                                                                                       mappings)    actions)         idempotent)
                                              ◄── Write-back outbox (COA, vendors, job-cost actuals) ◄── Books masters
```

**Rule: a connector never posts.** Adapters fetch and normalize. Only Books' existing typed actions (invoice, bill, payment,
JE services) create documents and GL, the same actions the UI and the agent layer call (canon decision #5). This matches the
current migration-provider rule ("the direct-API path ... never posts on its own") [R].

**Provider adapter interface.** Generalize `ConnectorProvider` (migration-only, six fixed fetchers) into an operational
interface. Design sketch, not code to commit as-is:

```ts
type AuthStrategy =
  | 'oauth2_code'               // QBO, Xero, Jobber, Procore, simPRO partner, Rippling, HubSpot
  | 'oauth2_client_credentials' // ServiceTitan (tenant id + client id/secret + platform App Key), Ramp, BC S2S
  | 'api_key'                   // Housecall Pro (MAX), JobTread grant key, BILL devKey, Trimble Vista
  | 'basic_session'             // RFMS (Basic → sessionToken), SAP B1 Service Layer
  | 'aggregator'                // Agave / Merge / Codat / Rutter / Finch link token
  | 'file_drop'                 // c-Systems GL export, Innergy Excel, Contractor Foreman, any CSV
  | 'on_prem_agent';            // QuickBooks Desktop Web Connector, Sage 300 CRE / 50 / 100

interface ConnectorObjectSpec {
  object: ConnectorObject;      // 'customer'|'job'|'estimate'|'invoice'|'payment'|'bill'|'po'|'vendor'|'item'
                                // |'employee'|'timesheet'|'payroll_run'|'gl_account'|'journal'|'inventory_txn'|'membership'
  direction: 'in' | 'out' | 'both';
  modes: Array<'backfill' | 'incremental' | 'webhook' | 'reconcile'>;
  cursorKind: 'updated_since' | 'opaque_token' | 'id_watermark' | 'none';
  master: 'external' | 'books' | 'core';   // §1.4 ownership
}

interface OperationalConnector {
  readonly id: string;                      // == catalog id == erp_connections.erp_id
  readonly auth: AuthStrategy;
  readonly objects: ConnectorObjectSpec[];
  readonly limits: { perSecond?: number; perMinute?: number; pageSize: number };
  discover(ctx: ConnCtx): Promise<Discovery>;          // business units, entities, GL accts, tax codes, pay types → mapping UI
  pull(ctx: ConnCtx, o: ConnectorObject, cursor: Cursor | null, window?: DateWindow): Promise<PullPage>; // raw + nextCursor
  normalize(o: ConnectorObject, raw: unknown): NormalizedRecord;   // deterministic profile (like providers/mapping.ts)
  verifyWebhook?(req: WebhookReq): VerifiedEvent | null;           // called by Core verify-and-route, never inline
  push?(ctx: ConnCtx, op: WritebackOp): Promise<WritebackResult>;   // only from the outbox
}
```

Every method stays **degrade-safe** like today's providers: missing credentials resolve to `not_connected` with a
plain-English reason, and nothing throws [R].

### 1.3 Credential vault: per tenant, per client, per entity

- **Secrets**: reuse `lib/money/secrets.ts` (Vault RPCs, service-role only). The row holds `secret_ref` only. The QBO store
  keeps the ref in `meta.secretRef` today; promote it to a column (§1.10).
- **Scope**: a connection belongs to an **org** (the client company). It may optionally pin to one **location** (entity),
  e.g. "Heartland simPRO build → location Heartland". It may also fan out: one ServiceTitan tenant with three business units
  maps to three departments, or two locations. The Merit-managed model (staff with memberships across many client orgs)
  needs **no** extra vault scoping: the connection is the client's, and access follows `core.memberships` + RBAC
  (`settings_system:edit` to connect).
- **Platform credentials vs tenant credentials**: platform app secrets (Intuit client id/secret, ST App Key, Ramp OAuth app,
  simPRO central client, Agave/Merge keys) live in env/Vault at **platform** scope. Tenant tokens live in Vault per connection.
  ServiceTitan needs both: our App Key (platform) **plus** the tenant's client id/secret/tenant id ([3P]
  [servicepytan prerequisites](https://servicepytan.readthedocs.io/en/latest/_sources/prerequisites.md.txt),
  [P] [Agave ST setup](https://docs.agaveapi.com/source-systems/servicetitan)).
- **Rotation**: copy the QBO token-manager rules for every OAuth provider: refresh inside a 5-minute skew, **persist the
  rotated refresh token before using it**, single-flight per connection, `invalid_grant` → status `revoked` + reconnect
  banner [R].

### 1.4 Ownership & conflict rules per object (who is master)

| Object | Master | MeritBooks behavior | Write-back |
|---|---|---|---|
| **Chart of accounts, dimensions** (location/department/class) | **Books** | Never imported live. Mapped *to* external codes in `integration_mappings` | **Push** to Ramp ([P] [Ramp ERP guide](https://docs.ramp.com/llms-guides/erp-integrations.txt)); simPRO/ServiceTitan GL-account lists where the API allows |
| **Vendors** | **Core identity / Books AP fields** (W-9, 1099, terms, hold) | Field-system-created vendors enter as **provisional** (`w9_status=missing`, unapproved) per ownership-matrix Rule C | Push approved vendors to Ramp and field systems where supported |
| **Customers** | **External** (ServiceTitan/simPRO/RFMS) for contact/location; **Core** identity; **Books** terms/credit/AR | Upsert into `core.customers` via `external_links`. Never overwrite Books-owned fields | No (read-only) |
| **Jobs / projects** | **External** for identity/status/phase; **Core** `core.jobs` mirror; **Books** rev-rec outputs + `revenue_account_id` | Map external job type → archetype / rev-rec method. Contract value, cost estimate and % complete arrive as **JOB_PROGRESS-shaped snapshots** (Books pins them) | Optional: push recognized revenue / WIP summary |
| **Estimates / quotes** | External | History/analytics only. **No GL** | — |
| **Invoices (AR)** | **External issues the document**, **Books records the AR** | Books creates `invoices` + lines from the external doc and keeps the external number for display. Books still mints its own invoice # (canon E; see §6 D1). **Edits after posting → credit memo / reversal + re-issue, never in-place** | No |
| **Customer payments** | External (and the processor) | Post Dr *Payment Clearing* (by payment type), Cr AR. The **bank-feed deposit match clears the clearing account**. That match is the double-count guard | No |
| **Bills / POs** | **Ramp** when Ramp is the AP rail; otherwise the field system | POs = commitments only (no GL). Received bills → AP. **One AP source per vendor invoice**: dedupe across Ramp, field system and AP inbox with an extended EC-1 detector | Mark synced in Ramp (`POST /accounting/syncs`) |
| **Timesheets / labor** | Field system (time) + payroll provider (pay) | Time for job-cost allocation. Pay from the payroll GL report. Labor cost emitted as `JOB_COST` (gate `TIMESHEET_PAYROLL`) | No |
| **Payroll runs** | Payroll provider | Post the payroll JE from the provider's GL report by department/job (Gusto has a GL report API: [P] [Gusto changelog](https://docs.gusto.com/embedded-payroll/changelog/general-ledger-api-now-available)). **No PII in app tables** | No |
| **Inventory** | Field system / DMS (c-Systems, simPRO, ServiceTitan, RFMS) | Valuation via periodic inventory/COGS JE + control-account tie-out. **MeritInventory is reserved: do not build quantity tracking** | No |
| **Job-cost actuals** | **Books** (sole cost originator, per canon) | Emitted as `JOB_COST` to Projects | Push to field systems only where they accept it. Most compute their own cost from their POs/time, so this is low value |

**Conflict resolution.** (1) The field owner wins and the other side is ignored, logged and never merged. (2) A changed
external doc after posting creates a **delta posting** (adjustment or credit memo), keyed on `source_ref …:v{n}`. (3) A
deleted/voided external doc → void if unpaid, else credit memo. (4) A **closed period** → rejected per Rule F and the item
lands in the error queue as user-actionable ("Period closed for Heartland, Sept 2026. Reopen or post to October."). It is
never silently re-dated.

### 1.5 How a ServiceTitan (or simPRO/RFMS) invoice reaches the GL

Accounts by **role** (canon guardrail: "reference accounts by role, not hard-coded number"):

| External event | Journal (roles) | Dimensions |
|---|---|---|
| Invoice finalized (service call) | Dr **AR** · Cr **Revenue** (item/category → revenue role via mapping) · Cr **Sales tax payable** | location ← business unit; department ← BU/trade; job_id ← job |
| Invoice on a membership / service agreement | Dr AR · Cr **Deferred revenue (2410 role)**. Then monthly rev-rec moves it to Revenue | rev-rec method from job type → archetype |
| Progress / milestone bill on a project job (Buildertrend, Innergy, ST construction) | Dr AR · Cr **Deferred revenue** (non-POS methods defer, per JOB_BILLING rule) · Cr Retainage receivable split if retainage | POC inputs via JOB_PROGRESS-shaped snapshot |
| Payment recorded (card / check / financing) | Dr **Payment clearing** (per payment type; financing → *Financing receivable*) · Cr AR | — |
| Bank deposit (Plaid) matched to the clearing batch | Dr Cash · Dr **Merchant fees** · Cr Payment clearing | Unmatched clearing balance > N days → exception |
| Inventory/vendor bill (ST export "inventory bills", simPRO vendor receipts) | Dr **Inventory** or **Job materials COGS** · Cr AP. When Ramp is the AP rail the bill comes from Ramp instead, and the field-system bill is a **match, not a post** | job_id → `JOB_COST` (MATERIALS, PAYABLE_APPROVAL) |

**Control check.** ServiceTitan's own accounting **export batches / journal entries** are reachable through the API
(accounting module: export invoices / payments / inventory bills, journal entries; [3P]
[Titanpy endpoint list](https://pypi.org/project/Titanpy)). Pull them as a **reconciliation control** (ST's own GL view of the
day vs. what MeritBooks posted), not as the posting source. Document-level posting keeps the invoice-level AR subledger and job
detail that a JE summary loses.

### 1.6 Sync engine

- **Scheduler (prerequisite INT-01)**: Vercel cron → `/api/cron/integrations/tick` (secret-gated) enqueues due work. The worker
  claims jobs from a Postgres queue (`FOR UPDATE SKIP LOCKED`), so no new infra is needed.
- **Modes**: **backfill** (date-windowed, resumable, newest-first for open AR), **incremental** (`modifiedOnOrAfter` /
  opaque cursor, 15–60 min), **webhook** (Core verify-and-route → enqueue only; process async), **nightly reconcile** (key-set
  diff to catch missed webhooks, deletes and voids; borrowed from Ramp's guidance to poll 1–4 h even with webhooks
  [P] [Ramp](https://docs.ramp.com/llms-guides/erp-integrations.txt)).
- **Idempotency**: (a) `external_links (connection, object, external_id)` unique; (b) `integration_inbound_records.payload_hash`
  skips no-op updates; (c) posting uses `gl_entries.source_ref = '{erp}:{tenant}:{object}:{id}:v{n}'` under the existing unique
  `(org_id, source_ref, entry_type)` index [R]; (d) outbound calls carry an idempotency key (Ramp `/accounting/syncs` dedupes on
  it [P]).
- **Rate limits** (per connection token bucket): ServiceTitan ≈60 req/s per app per tenant, reports 5/min per tenant [3P]
  ([rollout.com](https://rollout.com/integration-guides/servicetitan/api-essentials)); simPRO ≈10 req/s [3P]
  ([Supergood](https://supergood.ai/api-report-card/simpro)); Ramp batch uploads ≤500 items/request, all-or-nothing [P]; Vista
  ≈2,000/min [3P]; QBO CorePlus (GET) calls are **metered** by tier, Builder tier 500k/month free [3P]
  ([Apideck on Intuit pricing](https://www.apideck.com/blog/quickbooks-api-pricing-and-the-intuit-app-partner-program)).
- **Ordering**: masters (customers, vendors, items, jobs) before documents. A document whose master isn't linked yet waits
  in `staged` with a dependency, and doesn't fail.

### 1.7 Observability

- **Sync health widget** (`pf.integrations` for platform, `bk.feeds` for bookkeepers): per connection, status (connected /
  degraded / error / revoked / paused), last success, lag vs. target, records in/out today, open errors, next run.
- **Error queue** (new `integration_errors`): categories copied from Ramp's taxonomy:
  **user-actionable** (title + fix), **transient** (auto-retry with backoff), **needs-integrator** (ref id) [P]. One-click
  **Retry**, **Ignore with reason** (audited), **Open in source system** (deep link).
- **Replay**: every inbound payload is kept (scrubbed of payroll/bank PII), so any record re-runs mapper + posting without
  calling the vendor. A whole run can replay after a mapping fix.
- **Completeness detectors** (ride the `ai_decisions → /exceptions` library): *field-system revenue vs. GL revenue per day*,
  *Ramp-vs-GL completeness* (already planned, BNK-09), *payment clearing aging*, *external doc changed after posting*.

### 1.8 Onboarding: one-click historical import

1. **Connect** (OAuth / key / Agave Link) → `erp_connections` row `pending` → `connected`.
2. **Discover**: pull business units, entities, GL accounts, tax codes, payment types, job types, technicians.
3. **Map** (AI-proposed, human-approved, stored in `integration_mappings`): business unit → location/department; item category
   → revenue role; payment type → clearing account; job type → archetype / rev-rec method; tax code → tax liability.
4. **Pick the cutover date.** This must match the **opening trial balance** from the migration source (QBO/Sage/Xero) [R].
5. **Backfill** in two classes. **Before cutover**: import as **history-only** (no GL), for drill-down, AR aging continuity and
   analytics. The opening TB already contains those balances, so posting them would double-count. **Open items at cutover**:
   attach to the opening AR/AP so payments received after cutover apply correctly. **After cutover**: post live.
6. **Tie-out gate** (reuse the conversion tie-out): field-system AR aging at cutover = opening AR control. Human sign-off.
7. Flip to **incremental + webhooks**. The `erp_connections.last_sync_at` badge goes green.

### 1.9 The bookkeeper's daily loop

Morning: a **sync digest** (per client: N invoices / payments / bills posted overnight, $ totals vs. field-system totals). Then
the **To review** queue works connector exceptions in this order: unmapped items/BUs → closed-period rejects → unmatched
deposits vs. payment clearing → provisional vendors needing W-9 → duplicate-bill suspects (Ramp vs. field system) → changed
docs after posting. Month-end: Ramp unsynced-spend accrual (BNK-09), payment-clearing must be ~0, field-system AR = GL AR
tie-out per entity, job WIP inputs refreshed (JOB_PROGRESS snapshots) before the rev-rec run.

### 1.10 Schema additions needed (columns, not SQL; Core band; next migration number per `MIGRATION_REGISTRY.md`, latest file is 153)

**`core.erp_connections` (extend):** `external_tenant_id` (realmId / ST tenant / simPRO build / RFMS store); `location_id`
(nullable entity pin); `environment` (sandbox | production); `auth_strategy`; `secret_ref` (promote from `meta`);
`enabled_objects` (jsonb: object → direction/enabled); `cutover_date`; `last_error`, `last_error_at`; `connected_by`
(clerk_user_id); `paused_at`; extend `status` to add `revoked`, `paused`, `disconnected`. **Replace** unique
`(org_id, erp_id)` with `(org_id, erp_id, external_tenant_id)`.

**New tables (all: `org_id`, RLS `org_read` via `get_org_id()` + `service_all`, the 108 pattern; must pass `schema.test.ts` RLS
guard):**
- `core.integration_sync_cursors`: connection_id, object_type, cursor_kind, cursor_value, high_watermark_at, backfill_from,
  backfill_to, backfill_status, last_run_at, last_success_at, next_run_at, consecutive_failures.
- `core.integration_sync_runs`: connection_id, object_type, mode, started_at, finished_at, status, fetched / created / updated /
  skipped / failed counts, rate_limited_count, error_summary.
- `core.integration_inbound_records` (staging + replay): connection_id, object_type, external_id, external_updated_at,
  payload (jsonb, PII-scrubbed), payload_hash, received_via (poll / webhook / backfill / file), status
  (staged / waiting_dependency / mapped / posted / history_only / skipped / error), internal_table, internal_id, event_id,
  gl_entry_id, attempts, last_error.
- `core.external_links` (id map): connection_id, object_type, external_id, external_number, external_url, internal_table,
  internal_id, master (external | books | core), last_hash, last_synced_at. Unique (connection_id, object_type, external_id)
  and (connection_id, object_type, internal_id).
- `core.integration_mappings`: connection_id, mapping_kind (gl_account | item_category | business_unit | tax_code | payment_type
  | job_type | employee | vendor | entity), external_key, external_label, internal_id, confidence, proposed_by
  (rule | ai | user), approved_by, approved_at.
- `core.integration_errors`: connection_id, run_id, inbound_record_id, category (user_actionable | transient | needs_integrator),
  code, message (plain English), fix_hint, status (open | retrying | resolved | ignored), retry_count, next_retry_at,
  resolved_by, resolved_at, ignore_reason.
- `core.integration_webhook_events`: connection_id, provider_event_id (unique per connection), event_type, signature_valid,
  received_at, processed_at, status.
- `core.integration_outbox` (write-back): connection_id, object_type, internal_id, operation, payload, idempotency_key,
  status, attempts, external_id_result, last_error.

**Books documents (additive columns):** on `invoices`, `bills`, `customer_payments`: `origin_system`, `origin_connection_id`,
`external_doc_number` (display; Books still mints its own #), `external_url`.
**Enums / event types:** add connector `entry_type` values (e.g. `CONNECTOR_INVOICE`, `CONNECTOR_PAYMENT`, `CONNECTOR_BILL`,
`CONNECTOR_PAYROLL`, `CONNECTOR_INVENTORY`). `schema.test.ts` will fail the build if code posts one that's missing [R].
Add new `core.events.event_type` values for connector documents. This is additive and allowed by the FROZEN v3 contract
("new event types reuse the existing `core.events` table"); it does **not** alter JOB_COST / JOB_BILLING / JOB_PROGRESS shapes.

---

## 2. System table

Effort [J]: **S** ≤ 1 week · **M** 2–4 weeks · **L** 1–3 months (incl. certification). Priority: **P1** Merit go-live ·
**P2** next (market-critical) · **P3** long tail. Direction from MeritBooks' view: **In** = into Books, **Out** = Books pushes.

### 2a. Merit go-live systems (detailed)

**Ramp** (spend: cards, bill pay, reimbursements). Developer-API **accounting connection**: OAuth client credentials, scopes
`accounting:read/write`, `vendors:read`, plus `transactions:read`, `reimbursements:read`. **Push** GL accounts, custom fields
(Department/Location/Job), field options, vendors, entities (with `entity_remote_ids`). **Pull** `SYNC_READY` transactions,
bills, bill payments, reimbursements, transfers, cashbacks. **Ack** `POST /accounting/syncs` with `idempotency_key`
(success or failed + message, e.g. "Period closed"). Webhooks `*.ready_to_sync`; polling 1–4 h is fine. **One accounting
connection per Ramp business**, and switching drops historical codings unless you use the Migration tool. Ramp's own estimate
is 1–2 days minimal, 1–2 weeks hardened. Users must **never** click Ramp's manual Export button ([P]
[Ramp ERP Integrations guide](https://docs.ramp.com/llms-guides/erp-integrations.txt)). Direction **both** · **M** · **P1**.

**Plaid**: LIVE in sandbox [R]. Needs **production access** approval. Direction in · **S** · **P1**.

**QuickBooks Online** (migration + bridge): OAuth built [R]. Needs **production keys** from Intuit. API is metered under the
App Partner Program: Builder free up to 500k CorePlus calls/month; paid tiers Silver $300 / Gold $1,700 / Platinum $4,500 per
month [3P] ([Apideck](https://www.apideck.com/blog/quickbooks-api-pricing-and-the-intuit-app-partner-program),
[Truto](https://truto.one/blog/how-much-does-the-quickbooks-api-cost-2026-pricing-rate-limits/)). Needs **multi-company per
org** (index fix §1.10). Direction in · **S** · **P1**.

**Sage Intacct** (Clive's prior books): Web Services (XML/REST) needs a **Web Services Developer License** (≈$2,500/yr per
[3P] [Rutter](https://docs.rutter.com/platforms/accounting/sageintacct2)) or Marketplace-partner sender ID; included API volume
≈100k transactions/month on Tier 1 [3P] order form. **⚠ Clive's subscription was cancelled effective 10/1/2026** [IR].
Extract **now**, by any means (Sage export, aggregator, CSV). Direction in · **S** (CSV) / **M** (API) · **P1-urgent**.

**simPRO** (Heartland, HVAC): REST v1.0 + OAuth2 (authorization code; also client credentials), webhooks (`Webhook
Subscriptions`), API call limits page; objects: customers, contacts, sites, employees, contractors, vendors, **timesheets**,
**jobs, job cost centers**, recurring jobs, leads, quotes, catalogs, **inventory/stock**, vendor quotes/**orders**, **invoices**,
contractor invoices, **customer payments**, **vendor receipts/credits**, credit notes, **accounts**, tax codes, memberships,
**accounting** ([P] [Simpro API docs](https://developer.simprogroup.com/apidoc/)). Access: single-build app now; central partner
app after the partner agreement + 2-phase integration approval ([3P]
[Nango](https://nango.dev/docs/api-integrations/simpro/how-to-register-your-own-simpro-api-oauth-app.md)). Direction **both**
(push GL accounts/tax codes) · **M** · **P1**.

**FieldEdge** (Dorrian, HVAC; Xplor): Partner-only API on Azure API Management, "providing API access to our integrated
partners"; partner onboarding form + sandbox; members can build private integrations ([P]
[FieldEdge API](https://docs.api.fieldedge.com/), [P] [developer portal](https://docs-dev.fieldedge.com/welcome-to-the-fieldedge-developer-portal-1966285m0)).
Native QBO sync (bridge works). Direction in · **M** · **P1** (bridge) → P2 (direct).

**Buildertrend** (AIM, Revived; homebuilding/remodel): no public API; partner agreement via BD ([3P] above). Native syncs:
QBO/QBD (two-way, estimates/invoices/bills/payments), Xero, **Sage Intacct** (jobs, bills, invoices; 2026-06-30) ([P]
[BT × Intacct](https://buildertrend.com/integration/sage-intacct/), [P] [BT Xero](https://buildertrend.com/help-article/xero-initial-integration/)).
**Do not** use unofficial scrapers (Supergood-style) on a book of record. Direction in (bridge) · **S** bridge / **L** direct ·
**P1 via bridge**.

**Innergy** (Iowa Custom Cabinetry; millwork ERP + Microvellum CAD/CAM, also launched payroll): integrations with Sage,
QuickBooks, NetSuite. No public API found; Excel-template imports; "contact our team" ([P] [Innergy FAQ](https://www.innergy.com/faq/)).
Its job costing pulls actuals from purchases and time ([P] [job costing](https://www.innergy.com/erp/job-costing/)). Direction in ·
**S** bridge / **M** direct if Innergy grants access · **P1 via bridge**.

**RFMS** (Heritage; flooring ERP, Cyncly): REST; `POST /v2/session/begin` with Basic auth → `sessionToken`, sliding expiry
([3P] [Zapier thread quoting RFMS docs](https://community.zapier.com/general-discussion-13/authentication-combination-of-session-auth-and-basic-auth-7934)).
**Tiered by the customer's subscription**: Standard (customers, opportunities, quotes/orders read, post payment to order,
products, inventory search, claims, attachments) → Plus/Enterprise (create/manage orders + lines, assign inventory) ([P]
[RFMS API](https://rfms.com/solutions/api)). Cyncly bundles Basic API with RFMS Core and Advanced API (payments + data fetch)
with Professional ([P] [Cyncly RFMS Core](https://www.cyncly.com/products/rfms-core)). **RFMS has its own GL/journal package**
([P] [RFMS GL](https://rfms.support.cyncly.com/hc/en-us/articles/50200023050129)), but no GL/AP endpoints are listed in the API.
No webhooks listed (Zapier exists). Direction in · **M** · **P1**.

**c-Systems Infinity** (Clive; OPE dealer DMS): own GL with GL Interface Wizard defaults; QuickBooks Interface; financial
statements exportable from Report Viewer ([P] [KB](https://infinity.csystemssoftware.com/knowledgeBase/14605310)). No public API
docs found; the KB has an "API" heading but no content was reachable [3P search]. Phone 800-334-3114 (search listing).
Direction in · **S** file / **M+** if API · **P1 via file**.

**ServiceTitan** (HVAC/plumbing/electrical market leader): REST, OAuth2 client credentials + App Key; integration environment
(sandbox) at `api-integration.servicetitan.io`; scopes crm, jpm, accounting, inventory, payroll, memberships, pricebook,
settings, reporting ([3P] [servicepytan](https://servicepytan.readthedocs.io/en/latest/_sources/prerequisites.md.txt)).
Program: Silver/Gold/Titanium, certification (evaluation call → workflow rec → data & API questionnaire → sandbox → final
review), **annual dues + per-tenant connection fee or rev-share**, yearly recertification, "integrate UI into ServiceTitan
whenever possible" ([P] [Program Guide](https://www.servicetitan.com/legal/app-marketplace-program-guide)). ST's own accounting
integrations: QBO, QBD, Sage Intacct, Xero, CSV; marketing also lists Viewpoint Vista/Spectrum ([P]
[ST accounting integrations](https://help.servicetitan.com/docs/accounting-integrations-overview)). That tells us its export
model is GL-mapped batches. **Agave** already has a certified "Agave API Connector" app ([P]
[Agave ST](https://docs.agaveapi.com/source-systems/servicetitan)). Direction **both** · **M** via Agave / **L** certified ·
**P1 if Metro is on ST, else P2 (top of P2)**.

### 2b. Every system

| System | Category | API | Access / auth | Key objects | Hooks | Dir | Eff | Pri | Blockers / notes |
|---|---|---|---|---|---|---|---|---|---|
| **Ramp** | Spend | REST | OAuth app, scopes; sandbox [P] | GL accts, fields, vendors, entities; txns, bills, bill pmts, reimb | Yes | Both | M | **P1** | One connection per Ramp business; confirm multi-entity on API connection |
| **Plaid** | Bank feed | REST | Production approval | Txns, balances | Yes | In | S | **P1** | Already sandbox [R] |
| **QBO** | Migration + bridge | REST | Intuit prod keys; metered tiers [3P] | All accounting | Yes | In | S | **P1** | Multi-company per org; CorePlus metering |
| **Sage Intacct** | Migration (Clive) | XML/REST | Dev license or partner [3P] | GL, AR, AP, TB, dims | Limited | In | S–M | **P1 urgent** | **Subscription cancelled 10/1/2026** |
| **simPRO** | Field service (Heartland) | REST+OAuth2 [P] | Single-build app now; partner for multi-tenant | Jobs, cost centers, invoices, payments, vendor orders/receipts, stock, timesheets, accounts | Yes | Both | M | **P1** | ≈10 rps [3P] |
| **FieldEdge** | Field service (Dorrian) | REST (APIM) [P] | **Partner approval** | Customers, jobs, invoices, payments (behind partner sign-in) | ? | In | M | **P1 bridge** | Partner gate; docs behind login |
| **Buildertrend** | Construction (AIM, Revived) | Private | **Partner BD only** [3P] | Jobs, estimates, invoices, bills, POs, budgets | ? | In | L | **P1 bridge** | No API; native QBO/Xero/Intacct sync |
| **Innergy** | Millwork ERP (ICC) | None public [P] | Ask vendor | Jobs, POs, invoices, time | — | In | M | **P1 bridge** | No API; native QBO/Sage/NetSuite |
| **RFMS** | Flooring ERP (Heritage) | REST, Basic→session [P] | Customer's API tier | Customers, quotes/orders, payments, products, inventory, claims | No | In | M | **P1** | Tier upgrade cost; no GL/AP endpoints; hosted RFMS |
| **c-Systems Infinity** | OPE dealer DMS (Clive) | None public | Ask vendor | GL journal, invoices, parts/units inventory, service | — | In | S file | **P1 file** | Own GL; QuickBooks Interface; file export |
| **ServiceTitan** | Field service | REST [P] | Certified partner or via Agave; **no tunneling** | Customers, locations, jobs, appts, estimates, invoices, payments, AP bills/credits, POs, inventory, timesheets, memberships, pricebook, BUs, techs | Yes [3P] | Both | M/L | **P1/P2** | Fees, certification, recert yearly |
| **QuickBooks Time** (Heritage installers) | Time | REST, OAuth [J] | Intuit app | Timesheets, jobcodes | Yes | In | S | P2 | Verify plan; labor allocation |
| **SAP Concur** (Merit contract 12/5/2025 [IR]) | Expense | REST [J] | SAP App Center partner [J] | Expense reports, receipts | Yes | In | M | P2 | **Overlaps Ramp**; pick one per entity |
| **Jobber** | Field service | GraphQL, OAuth code [P] | App review; Draft capped at 5 paying accounts [P] ([Jobber docs](https://developer.getjobber.com/docs/building_your_app/app_authorization)) | Clients, jobs, quotes, invoices, payments, timesheets | Yes | In | M | P2 | Marketplace review |
| **Housecall Pro** | Field service | REST, API key | **Customer must be on MAX plan** [3P] ([Ampersand](https://docs.withampersand.com/customer-guides/housecallPro)) | Customers, jobs, estimates, invoices, payments | Yes (MAX) | In | M | P2 | Plan gate; QBO sync one-way [P] ([HCP help](https://help.housecallpro.com/en/articles/6293215-quickbooks-online-syncing-information-from-housecall-pro)) |
| **Successware** | Field service | SWAPI (customer-hosted NT service) [3P] | Partner | Jobs, invoices, customers, inventory | ? | In | L | P3 | On-prem service install [3P] ([Supergood](https://supergood.ai/api-report-card/successware)) |
| **ServiceTrade** | Commercial service | REST, OAuth2 [3P] | Dev account + sandbox [3P] ([apitracker](https://www.apitracker.io/a/servicetrade)) | Locations, assets, jobs, quotes, invoices | Yes | In | M | P3 | Confirm portal |
| **BuildOps** | Commercial service | No public API found | Partner | Jobs, POs, invoices | ? | In | L | P3 | Native Sage Intacct ([P] [BuildOps](https://buildops.com/resources/buildops-sage-intacct-integration)) |
| **Procore** | Construction PM | REST, OAuth [3P] | Dev portal + marketplace; ERP Connector platform open to 3rd parties ([P] press [BusinessWire](https://www.businesswire.com/news/home/20210715005912/en/New-Procore-ERP-Connector-Platform-Provides-Real-Time-Insight-on-Financial-Health-of-Construction-Projects)) | Projects, budgets, commitments, change orders, cost codes, sub invoices | Yes | Both | L | P2 | Or via Agave; Procore expects ERP to own GL (good fit) |
| **JobTread** | Construction | Pave query API, grant key [3P] ([JobTread cert](https://www.jobtread.com/resources/training/certifications/api-developer)) | Customer-created grant (expires after 3 mo idle [3P]) | Customers, jobs, budgets, documents (invoices/bills/POs) | Yes | In | M | P2 | Self-serve; good API |
| **CoConstruct** | Construction | — | — | — | — | — | — | **Skip** | Being retired into Buildertrend (new projects end ~4/1/2027 [3P] [JobTread](https://www.jobtread.com/news/jobtread-opens-a-migration-path-for-builders-facing-the-coconstruct-phase-out)) |
| **Contractor Foreman** | Construction | No public API; Zapier key only [3P] ([Supergood](https://supergood.ai/api-report-card/contractor-foreman)) | — | Leads/customers via Zapier | Zapier | In | S CSV | P3 | CSV/QBO bridge |
| **Foundation** | Construction acctg | Per-customer API, approval [3P] | Via **Agave** ([P] [Agave Foundation](https://agaveapi.com/integrations/foundation)) | Jobs, cost codes, AP/AR, payroll | — | In (migration) | M | P3 | Migration source mainly |
| **Viewpoint Vista** | Construction ERP | REST via Trimble App Xchange, API keys [P] ([Vista API](https://direct-api.xchange.trimble.com/docs)) | **Paid add-on, cloud-hosted only**, Trimble-provisioned [P]/[3P] | Jobs, AP, AR, GL, payroll | — | In (migration) | M | P3 | Or via Agave |
| **Viewpoint Spectrum** | Construction ERP | Data Exchange Web Services [P] ([Trimble dev](https://www.trimble.com/en/developer/docs)) | App Xchange admin [P] | Same | — | In | M | P3 | Agave |
| **Sage 300 CRE** | Construction ERP (on-prem) | Timberline ODBC; Web API needs DPP license [3P] ([Nango](https://nango.dev/docs/api-integrations/sage-300-cre.md)) | DPP / on-prem | GL, JC, AP, AR | — | In | M | P3 | On-prem; use Agave |
| **Sage 100 Contractor** | Construction ERP | On-prem | Via Agave | Same | — | In | M | P3 | Agave |
| **QuickBooks Desktop** | Migration | qbXML via **Web Connector** (SOAP polling, Windows) [P] ([Intuit](https://developer.intuit.com/app/developer/qbdesktop/docs/get-started/get-started-with-quickbooks-web-connector)) | Customer installs QBWC | All accounting | — | In | M | P2 | Use aggregator (Codat is Intuit-approved [P] [Codat QBD](https://www.codat.io/integrations/accounting-quickbooks-desktop/)) |
| **Xero** | Migration | REST, OAuth | **Tiered dev pricing since 2 Mar 2026**: Starter 5 conns free, Core 50 ($35 AUD), Plus 1,000 ($245), Advanced 10k ($1,445) [P] ([Xero pricing](https://developer.xero.com/pricing)); Journals API not on Starter [3P] | All accounting | Yes | In | S | P2 | Migration volume fits Core tier |
| **Sage 50 (US)** | Migration | .NET SDK, local machine [3P] ([Sage SDK guide](https://communityhub.sage.com/cfs-file/__key/communityserver-discussions-components-files/136/Sage-50-.NET-API-_2D00_-Quick-Start-Guide.pdf)) | Desktop | All accounting | — | In | M | P2 | Codat ([P] [Codat Sage 50](https://www.codat.io/integrations/accounting-sage-50/)) or CSV |
| **Sage 100** | Migration | No modern REST [3P] | Business objects / SQL | Same | — | In | M | P3 | CSV / aggregator |
| **NetSuite** | ERP | SuiteTalk REST + OAuth2 (integration record per account) [3P] | Customer admin enables; partner optional | All | Yes | Both | M | P2 | Customer-side setup heavy |
| **Acumatica** | ERP | Contract-based REST + OAuth2 (Connected App SM303010) [3P] | Customer creates connected app | All + webhooks | Yes | Both | M | P2 | Agave covers; ST↔Acumatica via Agave [P] |
| **Dynamics 365 BC** | ERP | REST API v2.0, Entra app (single/multi-tenant), S2S [P] ([MS Learn](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/automation-apis-using-s2s-authentication)) | Entra app registration + admin consent | GL entries, journals, vendors, customers | Yes | Both | M | P2 | Good multi-tenant story |
| **Epicor Kinetic** | ERP | REST v2 (OData) + API key + Basic/Bearer [3P] ([epiusers](https://www.epiusers.help/t/rest-api-401-unauthorized-errors/107006)) | Customer-issued | All | — | In | M | P3 | Mid-market mfg/distribution |
| **Infor CloudSuite** | ERP | ION API Gateway, OAuth2 (.ionapi file) [P] ([Infor LN docs](https://docs.infor.com/lnui/2026.04/en-us/lnuisettingsolh/lnuiag/kkn1518793674434.html)) | Customer admin | All | — | In | L | P3 | Enterprise; rare in SMB trades |
| **SAP Business One** | ERP | Service Layer OData v4, session login [3P] ([Apideck](https://www.apideck.com/blog/sap-business-one-api-integration-guide)) | Customer/partner-hosted | All | — | In | M | P3 | Often partner-hosted, network access |
| **Odoo** | ERP | JSON-2 API (XML/JSON-RPC deprecated) [P] ([Odoo docs](https://www.odoo.com/documentation/19.0/es_419/developer/reference/external_rpc_api.html)) | **Custom plan only** for external API [P] | All | — | Both | M | P3 | Plan gate |
| **Brex** | Spend | REST, OAuth (admin consent) [3P] ([Brex dev](https://developer.brex.com/guides/roles_permissions_scopes)) | Developer portal app | Card txns, expenses, receipts | Yes | In | M | P2 | Mirrors Ramp pattern |
| **BILL** | AP/AR | REST v3, devKey + session [3P] ([BILL dev](https://developer.bill.com/docs/api-sandbox-sign-up)) | Developer account; sandbox | Bills, payments, vendors | Yes | Both | M | P2 | Overlaps Ramp bill pay |
| **Gusto** | Payroll | REST, OAuth2; **GL report API** [P] ([Gusto](https://docs.gusto.com/embedded-payroll/changelog/general-ledger-api-now-available)) | App Integrations partner [P] ([build an app](https://docs.gusto.com/app-integrations/docs/build-an-application)) | Payroll runs, GL report by dept/job, employees | Yes | In | M | P2 | Also candidate payroll provider (task #32) |
| **ADP WFN/RUN** | Payroll | REST | **Marketplace partner + sandbox agreement**; client buys API Central (~$2–3/employee/mo) [P] ([ADP](https://esi.apps.adp.com/en-US/pages/why-marketplace)) | Payroll, workers | Limited | In | L | P2 via Finch | Costly gate; use Finch |
| **Paychex Flex** | Payroll | REST, OAuth2 [P] ([Paychex dev](https://developer.paychex.com/getting-started/integrate-with-paychex-clients)) | Partner review (weeks–months [3P]); no webhooks [3P] | Workers, payroll, time | No | In | M | P2 via Finch | Partner gate |
| **Paylocity** | Payroll | REST, client credentials [P] ([Paylocity dev](https://developer.paylocity.com/integrations/docs/getting-started)) | Developer Partner Program; sandbox | Employees, payroll, webhooks | Yes | In | M | P3 via Finch | Partner relations process |
| **Rippling** | Payroll/HRIS | REST, OAuth via App Shop listing [3P] ([Prismatic](https://prismatic.io/docs/components/rippling)) | **Partner vetting**; rejection is final [3P] ([Merge help](https://help.merge.dev/articles/9265388-rippling-how-do-i-set-up-my-integration)) | Employees, payroll | Yes | In | M | P3 via Finch | Gatekept |
| **HubSpot** | CRM | REST, OAuth public app [P] ([cert reqs](https://developers.hubspot.com/docs/api/certification-requirements)) | Free dev account; certification optional | Deals, line items, companies | Yes | In | S | P3 | Pipeline/backlog for FP&A only |
| **Salesforce** | CRM | REST, connected app | AppExchange security review ≈$2,700 one-time if listed [P] ([SF docs](https://developer.salesforce.com/docs/atlas.en-us.244.0.packagingGuide.meta/packagingGuide/security_review_fees.htm)) | Opportunities, quotes, orders | Yes | In | M | P3 | Only list if selling there |
| **Shopify** | Commerce | Admin GraphQL, OAuth | App review | Orders, payouts, balance txns ([P] [changelog](https://shopify.dev/changelog/additions-to-the-graphql-api-for-shopify-payments-payouts-and-balance-transactions.md)) | Yes | In | M | P3 | Payout-to-txn linkage quirks [3P] |
| **Square** | POS/payments | REST, OAuth [P] ([Square](https://developer.squareup.com/docs/changelog/connect)) | Self-serve | Payments, payouts, orders | Yes | In | M | P3 | Clive-type retail counters may use it [J] |
| **Stripe** | Payments | REST | Connect (already LIVE test) [R] | Charges, payouts, fees | Yes | In | — | Done | Extend payout→deposit match |
| **Knowify / JobNimbus / AccuLynx / QFloors / RollMaster / Comp-U-Floor** | Trades niche | Varies (not researched) | — | — | — | In | ? | P3 | In catalog [R]; confirm demand first |

### 2c. Aggregators / unified APIs (shortcuts)

| Aggregator | Covers (relevant) | Write-back | Pricing signal | Use for MeritBooks |
|---|---|---|---|---|
| **Agave** | **ServiceTitan, Procore**, Foundation, Sage 300 CRE, Sage 100 Contractor, Sage Intacct, QBO, **QBD**, Acumatica, CMiC, ComputerEase, Viewpoint Vista/Spectrum/Jobpac, Autodesk Build; passthrough for unmodeled endpoints; sandboxes; webhooks ([P] [Agave source systems](https://docs.agaveapi.com/source-systems)) | Yes (read/write) | Contract ([pricing](https://useagave.com/software-vendors/pricing)) | **Phase-1 route to ServiceTitan** (Agave is a certified ST app) + all construction ERPs as migration sources. **Does not** cover Buildertrend, simPRO, RFMS, Innergy, c-Systems, FieldEdge |
| **Merge** | QBO, QBD, Xero, NetSuite, Sage Intacct, Zoho, FreshBooks… ([P] [Merge accounting](https://docs-new.merge.dev/merge-unified/accounting/integrations)) | Partial | Launch ≈$650/mo for 10 linked accounts + $65 each [P] ([Merge QBO page](https://merge.dev/integrations/quickbooks-online)) | Long-tail **migration sources** (one-time; disconnect after cutover to stop fees) |
| **Codat** | QBO, **QBD (Intuit-approved)**, **Sage 50**, Xero, NetSuite… | Yes (bills, invoices, payments) | Sales-led [3P] | Desktop-era migrations (QBD, Sage 50) without building Web Connector/SDK |
| **Rutter** | QBO, QBD, Xero, NetSuite, Sage Intacct, Dynamics, Zoho; **plus commerce** (Shopify, Square, Stripe…) ([P] [Rutter](https://rutterapi.com/)) | Write on QBO/NetSuite first [P] | Sales-led | Alternative to Merge + commerce in one contract |
| **Apideck** | 52+ accounting connectors incl. QBD (beta) ([P] [Apideck](https://www.apideck.com/accounting-api/connectors.md)) | Yes | Published tiers | Merge alternative; no field-service API |
| **Finch** | 200+ HR/payroll providers (Gusto, ADP, Paychex, Paylocity, Paycom…); **Assisted** connections for providers with no API; 24h / weekly sync ([P] [Finch vs Merge](https://tryfinch.com/finch-vs-merge)) | Mostly read (deductions write) [3P] | Sales-led; Assisted on Scale plans | **Payroll JE feed for any provider**, avoiding ADP/Paychex/Rippling partner gates |
| **Nango** (open-source auth/proxy, not a unified model) | OAuth + proxy for 400+ APIs incl. simPRO, Paylocity, Vista, Bill ([P] [Nango simPRO](https://nango.dev/docs/api-integrations/simpro.md)) | Passthrough | OSS / hosted | Optional: offload OAuth/token plumbing for direct connectors. We already have a good pattern, so low priority |

**Tradeoffs.** Aggregators win on time-to-coverage and maintenance. They lose on **job / business-unit / cost-code depth**
(lowest-common-denominator models), **per-connection fees forever**, **latency** (polling layers), **write-back gaps**,
**vendor lock-in**, and **a new subprocessor holding tenant financial credentials** (security review + DPA + SOC 2 report
required for a fintech book of record). **Recommendation [J]:** aggregator for (a) one-time migration sources, (b) payroll
breadth (Finch), (c) ServiceTitan + construction ERPs **until** direct/certified access exists (Agave). Direct for the
high-volume daily systems where depth matters: Ramp, Plaid, simPRO, RFMS, and ServiceTitan long-term.

---

## 3. Phased roadmap

### Phase 0: prerequisites (2–3 weeks, lead-serialized: migrations + shared spine)
1. **Scheduler INT-01** (Vercel cron + Postgres job queue) and the integration tables of §1.10.
2. Fix `erp_connections` uniqueness (multi-company / multi-tenant per org); promote `secret_ref`.
3. Generalize `ConnectorProvider` → `OperationalConnector`; staging + mapper + posting via `core.events` (new event types);
   error queue + sync health widget; replay.
4. Catalog corrections: add `simpro`, `fieldedge`, `c-systems`, `ramp`, `sage-intacct`, `netsuite`, `successware`,
   `quickbooks-desktop`; set ServiceTitan `connectionMethod` to `OAUTH` (client credentials via certified app / Agave); mark
   Buildertrend / Innergy as `PLANNED · bridge`; fix the `compufloor` description (it is not c-Systems).
5. Security review of the connector layer (RLS on all new tables, Vault-only secrets, webhook signatures via Core, PII scrub).

### Phase 1: Merit go-live (≈8–12 weeks after Phase 0, parallel slices)
| Wave | System | Path | Why now |
|---|---|---|---|
| 1A | **Sage Intacct (Clive)** | Emergency extract (CSV/report export now; API/aggregator if access remains) → opening TB | Subscription cancelled 10/1/2026 |
| 1A | **QBO multi-company** | Existing OAuth; one connection per entity company | Migration of 10+ entities |
| 1A | **Ramp** | Direct Developer-API accounting connection | Time-sensitive (CG §2): don't connect Ramp to QBO per entity |
| 1A | **Plaid production** | Existing | Deposit matching is the double-count guard |
| 1B | **simPRO (Heartland)** | Direct, single-build OAuth app now → central partner app later | Best API |
| 1B | **RFMS (Heritage)** | Direct REST (session auth), polling | Heritage stack complexity |
| 1C | **Bridge mode** for **Buildertrend (AIM, Revived), Innergy (ICC), FieldEdge (Dorrian), c-Systems (Clive)** | Field system → its native QBO sync → MeritBooks pulls QBO txns daily, mapped by class/customer:job → Books documents | No API today; reuses the built connector |
| 1C | **c-Systems** alt | Daily/weekly GL-journal or financial-statement export file → CSV import profile | If Clive won't keep a QBO company |
| 1D | **ServiceTitan** (only if Metro or another entity is on it) | **Agave** (certified app) | Avoids ST certification on the critical path |

### 3.2 Bridge mode, explained
Each entity keeps its existing QBO company (already paid for) receiving the field system's native sync. MeritBooks treats that
QBO company as a **feed, never as the ledger**. It ingests invoices, payments, bills and JEs created by the field-system sync
user, maps QBO accounts/classes to MeritBooks roles/dimensions, and posts. When a direct connector ships, the bridge for that
entity turns off on a cutover date (`external_links` keep continuity). **Costs:** QBO subscription stays; QBO CorePlus calls are
metered; detail is limited to what the field system pushes to QBO (often summary-level for jobs). **Canon:** needs Mike's ruling
(§6 D2) because QBO stays in the loop after migration.

### Phase 2: market-critical breadth (next 3–6 months)
ServiceTitan **certified direct app** (keep Agave as fallback); FieldEdge **direct** (partner); Jobber; Housecall Pro; JobTread;
Procore; Gusto + **Finch** (ADP, Paychex, Paylocity, Rippling, Paycom); Brex; BILL; NetSuite; Acumatica; Business Central;
Xero / QBD / Sage 50 migrations via Merge or Codat; QuickBooks Time; SAP Concur (if kept); Buildertrend **direct** if the
partnership lands.

### Phase 3: long tail (6–12 months, demand-driven via the catalog's REQUEST rows)
Agave-backed construction ERPs (Foundation, Viewpoint Vista/Spectrum, Sage 300 CRE, Sage 100 Contractor) as migration sources;
ServiceTrade, BuildOps, Successware; Epicor, Infor, SAP B1, Odoo; HubSpot / Salesforce (pipeline → FP&A); Shopify / Square;
niche flooring (QFloors, RollMaster, Comp-U-Floor) and roofing (JobNimbus, AccuLynx).

---

## 4. What Mike must do: plain-English checklist

**First, this week**
- [ ] **Clive / Sage Intacct:** call Sage today. Ask whether read-only access or a data export is still available after the
  10/1/2026 cancellation. Export the full GL detail, trial balances (every month of FY2025–26), AR/AP aging, and customer and
  vendor lists. Also: **what is Clive's books of record right now?**
- [ ] **Fill in the tech-stack gaps:** which field system and books do Metro, Crystal K&B, Swan Creek, Artistry Homes, Wild Rose,
  MMG and SPE 5 use? Is **any** entity on ServiceTitan? Which payroll provider does each entity use?
- [ ] **Ramp:** create a Ramp developer OAuth app (sandbox first) with scopes `accounting:read`, `accounting:write`,
  `vendors:read`, `transactions:read`, `reimbursements:read`, `bills:read`. Ask your Ramp rep in writing whether all ~15 entities
  can sit in one Ramp business with an API accounting connection. **Do not connect Ramp to QuickBooks.**
- [ ] **Intuit:** finish the Intuit developer production-keys questionnaire for the existing QBO app. Confirm the accountant
  console can authorize **each** company (one OAuth per company).
- [ ] **Plaid:** submit the production access application.

**simPRO (Heartland)**
- [ ] Have Heartland's simPRO admin create an API application: System → Setup → Integrations → API → Applications. Use OAuth 2.0,
  Authorization Code, and the redirect URI we give you. Send the Client ID/secret through the secure connect screen, **not email**.
- [ ] Apply to the Simpro partner program (simprogroup.com/partners) so other simPRO tenants can connect later.

**RFMS (Heritage)**
- [ ] Ask Cyncly/RFMS what API level Heritage has (Standard / Plus / Enterprise) and the price to move to the level that includes
  orders + payments + inventory reads. Get the API store/username + key issued to MeritBooks. Confirm whether hosted RFMS adds
  restrictions.

**Buildertrend (AIM, Revived)**
- [ ] Email Buildertrend partnerships / BD: "MeritBooks is a general-ledger platform. We want partner API access to jobs,
  invoices, bills, POs and payments." Meanwhile make sure each entity's Buildertrend → QuickBooks sync stays **on** (bridge
  mode).

**Innergy (Iowa Custom Cabinetry)**
- [ ] Ask ICC's Innergy contact whether there is an API or partner program, and which export formats exist (AP, AR, time). Keep
  Innergy → QuickBooks sync on.

**c-Systems (Clive)**
- [ ] Call c-Systems (Infinity). Ask: (1) is there an API? (2) what file format does the QuickBooks Interface produce? (3) can
  Infinity export the GL journal (daily/monthly) to CSV? Share a sample export with us.

**FieldEdge (Dorrian)**
- [ ] Submit the FieldEdge partner onboarding request (fieldedge.com/partners, "Become a FieldEdge Partner"). Keep Dorrian's
  FieldEdge → QuickBooks sync on meanwhile.

**ServiceTitan (if any entity uses it, and for the market)**
- [ ] Short term: sign with **Agave**. The entity installs "Agave API Connector" in ServiceTitan.
- [ ] Long term: apply to the ServiceTitan App Marketplace Program. Expect an evaluation call, a data questionnaire, annual
  dues, and a per-connection fee or rev-share. Ask integrations@servicetitan.com in writing whether a Merit-affiliated platform
  counts as a "Customer-Built App" for Merit-owned entities. Do **not** have anyone share an App Key with us. ServiceTitan calls
  that "tunneling" and prohibits it.

**Payroll**
- [ ] Decide Check vs Gusto (task #32). For entities on ADP/Paychex/others, approve a **Finch** evaluation instead of three
  partner applications.

**Aggregators (if approved)**
- [ ] Get pricing + DPA + SOC 2 reports from Agave (and Merge or Codat for migrations). Add them to the subprocessor list.

**General (most partner programs ask for these)**
- [ ] A MeritBooks legal entity, W-9, cyber/E&O insurance certificate, a public privacy policy and security page, and a
  **SOC 2 plan**. Intuit, ServiceTitan, ADP and Rippling all review security.

---

## 5. Risks

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R1 | **Clive's Sage Intacct data is lost or locked** after the 10/1/2026 cancellation | High / **critical** | Emergency extract this week; reconstruct from c-Systems Infinity GL if needed |
| R2 | **Partner gatekeeping**: Buildertrend, FieldEdge, Innergy, c-Systems may say no or move slowly; ServiceTitan certification takes months and charges recurring fees; Rippling rejection is final | High / high | Bridge mode; Agave for ST; demand letters from Merit entities as paying customers; start applications in Phase 0 |
| R3 | **ServiceTitan "tunneling" violation** if anyone shares an App Key | Medium / high (account disconnection) | Certified app or Agave only; written confirmation from ST |
| R4 | **API gaps**: RFMS has no GL/AP endpoints or webhooks; Buildertrend/Innergy/c-Systems have no API; Housecall Pro needs MAX; Odoo needs the Custom plan; Vista is a cloud-only paid add-on | Certain / medium | Per-system fallbacks (poll, bridge, file); mark plan gates in the Connect UI before the user clicks |
| R5 | **Double counting**: field-system payment + bank deposit; Ramp bill + field-system bill; bridge-QBO txn + direct connector during cutover | High / high | Payment-clearing design; one-AP-source rule + EC-1 extension; per-entity cutover dates in `external_links`; completeness detectors |
| R6 | **Pricing creep**: Intuit CorePlus metering, Xero tiers, ST dues + per-connection fees, ADP API Central per employee, aggregator per-linked-account fees, RFMS tier upgrade | High / medium | Track cost per connection in `erp_connections.meta`; disconnect migration-only links after cutover; prefer webhooks over polling |
| R7 | **Canon conflicts**: externally-issued invoice numbers vs. Books-mints-numbers; QBO staying in the loop (bridge) vs. "migration-only" | Certain / medium | Owner rulings D1/D2 before Phase 1 code |
| R8 | **Security**: a new subprocessor holding tenant credentials; webhook spoofing; payroll PII in staged payloads | Medium / high | Vault-only secrets; Core webhook verify; PII scrub before staging; security agent review per connector |
| R9 | **Vendor churn**: CoConstruct retirement; Odoo RPC removal (2028); QuickBooks Desktop product narrowing; Sage Intacct exits | Medium / medium | Adapters behind one interface; version pins; catalog status flags |
| R10 | **Third-party evidence**: many API facts here come from integrators, not vendors | Medium / medium | Each connector slice starts with a spike against the vendor's own sandbox/docs before estimates are trusted |
| R11 | **Scheduler not built** (INT-01), so nothing syncs | Certain / blocking | Phase 0 item 1 |

---

## 6. Owner decisions needed

- **D1: invoice numbering for externally-issued invoices.** Canon (ownership matrix Rule E) says Books mints invoice #. A
  ServiceTitan or RFMS invoice already has a customer-facing number. **Proposal:** Books mints its internal # and stores and
  displays `external_doc_number` as the customer-facing reference. Needs a Master-Doc amendment line.
- **D2: bridge mode.** Allow QBO to stay as a *transport* for field systems without an API during transition (not as the ledger)?
- **D3: aggregators as subprocessors.** Agave (ServiceTitan + construction ERPs), Finch (payroll), Merge or Codat (migrations).
- **D4: Ramp vs. SAP Concur** for expenses (Concur contract signed 12/5/2025 [IR]). Running both doubles the dedupe surface.
- **D5: the ServiceTitan program tier/fee model**, once ST quotes it.
