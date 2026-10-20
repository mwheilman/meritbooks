# 06 — Existing UI heuristic audit (pre-redesign)

**Date:** 2026-10-18 · **Purpose:** owner instruction "consult the existing user interface as well" before the
IA-SPEC / design-studio v2 redesign is built. Read-only; no code changed.
**Inputs:** `docs/ia/IA-SPEC.md` (§3 nav, §4 homes, §8 screens), `docs/ia/03-CODE-INVENTORY.md`,
`apps/web/src/lib/navigation.ts`, every `apps/web/src/app/(app)/**/page.tsx` and its client components, the shell
(`components/layout/*`, `components/nl/command-bar.tsx`), and `design-studio/v2/S1–S12`.

## 0. Method and a limitation you need to know

- **Update 2026-10-19:** the owner signed in and the live pass is now complete. Results are in **§L**, which supersedes the
  "blocked" notes below.
- **Live pass was blocked (first attempt).** The Chrome session was **not signed in**. Both `/dashboard` and `/` redirected to the
  Clerk dev sign-in page (`concise-dolphin-51.accounts.dev/sign-in`, "Development mode"). I did not sign in: entering
  credentials or authorizing Google SSO needs the owner. So there are **no live screenshots, no observed render or
  load timing, and no console or network capture** from the authenticated app. The tab was put back on the S6 design URL.
- **What this audit rests on instead:** a full static read of every route (page + client components + the API it
  calls), split across four parallel read-only passes, with the important claims spot-checked by hand (marked ✔).
  Empty/loading/error behaviour is what the code renders, not what was seen.
- **To finish it:** Mike signs in to `meritbooks-web.vercel.app` in Chrome, then a chrome-auditor pass covers §7
  (screenshots of the ~25 key pages, console and network, the "All companies" state, and switching between companies).

Legend for the **Rec** column: **KEEP** (carry over mostly as-is) · **REWORK** (keep the capability, redesign the
surface) · **MERGE** (fold into the named home) · **RETIRE** (remove; add a redirect if needed).

---

## 1. Page inventory

### 1.1 Counts

- **Directories:** 119 page directories under `app/(app)/`.
- **Sidebar destinations:** 64 in `navigation.ts`, across three planes:
  - **Books:** 7 groups — Home, Payables, Receivables, Banking & Cash, Accounting, Jobs & Costing, Reporting & Analytics.
  - **Practice:** Team & Oversight, Settings & Admin.
  - **Platform:** Operator Console.
- **Redirect stubs (17):** `/budgets/drivers`, `/budgets/reforecast`, `/cash-application`, `/close-status`, `/controls`,
  `/covenants`, `/credit-cards`, `/exceptions`, `/flagged`, `/forecast`, `/intercompany`, `/invoices/collections`,
  `/recurring-journal-entries`, `/sales-tax-calendar`, `/sales-tax-return`, `/year-end-close`, plus `/settings/permissions`
  (renders the same `RolesClient` as `/settings/roles`).
- **Off-nav routes** (reachable only through tabs or links): `/retainage`, `/bills/intake-queue`, `/bills/policy`,
  `/expenses/policy`, `/compliance-1099`, `/fixed-assets`, `/leases`, `/prepaids`, `/insurance`, `/intangibles`,
  `/tax-depreciation`, `/book-to-tax`, `/tax-provision`, `/tax-package`, `/tax/sales-tax`, `/recurring`,
  `/portfolio/[id]`, `/jobs/[id]`, `/inventory/[id]`, `/inventory/valuation`, `/onboarding/*`, `/sandbox`,
  `/settings/new-entity`, `/settings/payments/*`.

### 1.2 Shell (applies to every page)

| Element | Code | What it does | Issues |
|---|---|---|---|
| **Company picker** | `components/layout/header.tsx`, cookie `mb_active_company` | Lists "All Companies" plus the companies you are assigned. Shown only in the Books plane. | In the All state, `CompanyScopeGuard` (`components/company-scope-guard.tsx`) replaces about 40 processing pages with a "pick a company" list. **The sidebar also hides every group except Home** (`sidebar.tsx:26` `mustSelectCompany`) ✔. That hides Reports, FP&A, Consolidation and Board Package, even though those pages support all-companies. |
| **Plane switcher** | `layout/plane-switcher.tsx`, `lib/planes.ts` | Switches between Book of Record, Practice and Platform. | It is a third switcher on top of the company picker and plane badge. IA-SPEC replaces it with one context switcher (⌘J). |
| **⌘K command bar** | `components/nl/command-bar.tsx` | Plain-English requests routed to processing, analytics or navigation (`/api/nl`). Pinned questions, 7 suggestions, FP&A metric chips, footer "AI proposes · you approve". Opens with ⌘K or `/`; arrow keys, Enter, Esc; Tab stays inside. | **⌘K is bound twice** ✔: `header.tsx:43` opens the search palette and `command-bar.tsx:75` opens the command bar. One keypress opens both, and the command bar's higher z-index hides the palette. |
| **Search palette** | `layout/search-palette.tsx` | Search scoped to the active company (`/api/search`), grouped results, loading, error and empty states. | Duplicates the `/search` page, which does **not** pass the active company. |
| **"CPA Desk ⌘K" button** | `sidebar.tsx:153` | — | **Dead** ✔: the button has no `onClick`. |
| **Notifications bell** | `layout/notifications-bell.tsx` | Polls `/api/inbox` every 60 s; the count matches the Inbox "need you" badge; links straight to each item. | Good. |
| **Help** | `components/help/help-button.tsx`, `lib/help/help-content.ts` | A help button inside `PageHeader`, with a floating fallback. Content is matched by longest path prefix. | No entries for `/pbc`, `/settings/billing` or `/settings/roles`. Copy still says "portfolio". |
| **Active-company chip** | `components/ui/active-company-indicator.tsx` | Shows "Working in X". | Rendered only through `PageHeader`, so pages that build their own `<h1>` don't show it: Invoices, Estimates, Vendors, Customers, Agents, Intake queue. |
| **Front door** | `app/(app)/page.tsx`, `lib/onboarding/flow` `resolveFrontDoor` | Routes signed-out users to sign-in, users with no org to `/setup`, the setup owner to `/onboarding`, first-time invitees to `/onboarding/tour`, everyone else to `/dashboard`. | Keep the resolver; IA §3.2 changes its targets. |

### 1.3 Page-by-page

#### Home

| Route | Purpose · roles | Components | Workflows / keys | States · data | Issues | Rec |
|---|---|---|---|---|---|---|
| `/dashboard` | Status board across companies · owner/leadership | "Consolidated" strip of 6 figures; one card per company (4 count tiles, Cash/AR/AP, period pill); activity feed (15) | Click a tile: pins that company and jumps to its queue. "Enter workspace" goes to `/bank-feed`. | Skeletons, error card, empty "No companies yet" · server actions | No page guard. Shows every company to everyone (IA R12). "Attention" tile links to the stub `/exceptions`. "Proposals" count is read from a field named `openExceptions`. Opens with a banner, which the owner rejected. | **REWORK**: becomes the role homes (IA §4). Keep the pin-and-jump behaviour. |
| `/inbox` | One "needs you" screen · everyone | Tabs Approvals / Exceptions / Alerts / Drafts (`?tab=`); "need you" badge; Alerts-within-N-days selector; severity and group chips; sort; local snooze; recently-resolved list | `j`/`k`/arrows move, Enter opens, `e` resolves a safe item (`inbox/use-list-keynav.ts`). Inline resolve for non-financial items only. | Spinner, error with Retry, "caught up" empty state, "some sources skipped" note · `/api/inbox`, `/api/exceptions` | Strongest page in the app. | **KEEP**: becomes the workspace Inbox and should also exist inside a client (see §3). |

#### Payables

| Route | Purpose · roles | Components | Workflows / keys | States · data | Issues | Rec |
|---|---|---|---|---|---|---|
| `/bills` | AP register · AP clerk/bookkeeper | Tabs All / Intake / Retainage / AP Policy; status filters; 9-column table with hover peek; custom slide-over `bill-detail.tsx` with ExplainPanel and AttachmentsPanel | Approve & post, Schedule, Pay (partial allowed), Void, Release hold, Re-route approver, Auto-file invoice, New Bill with AI parse. Esc. | Skeleton, error, empty · `/api/bills*` | **Silent 50-row cap** (`api/bills/route.ts:32`), no paging. Drawer is hand-built instead of the shared DetailDrawer. `bill-form.tsx` is 652 lines. | **KEEP + fix** paging and drawer |
| `/bills/intake-queue` | AI-drafted bills from documents | List with ConfidenceBar on the left, review panel and source document on the right, upload modal | Approve into bill, Reject | Skeleton, error, empty | No CompanyScopeGuard. Own `<h1>`. Jargon: "Azure OCR", "the machine reads". One of four ways to turn a document into a bill. | **MERGE**: becomes the "Draft bills" lane of To review (S2 step 1) |
| `/bills/policy` | Turn a written AP policy into rules · controller | Active-version card, version history, compile modal, rule editor | Compile from document, New version, Activate | Skeleton, empty | Near-copy of `/expenses/policy` (about 274 lines differ). Jargon: "schema-validated ruleset (config, never code)". | **MERGE** with expenses policy into Settings → Policies |
| `/expenses` | Expense reports and cards · employees, approvers, AP | Tabs My Reports / Approver Queue / Reimbursement Batch; 4 metric cards; DetailDrawer with policy violations, card-match picker, receipt picker | Submit, Approve (blocked for the submitter), Reject, Post reimbursement, batch Reimburse | Skeleton, empty | 951 lines. Reject uses `window.prompt` twice. Has its own ConfirmDialog. | **KEEP**, split the file |
| `/expenses/policy` | Expense policy into rules | Same as AP policy | Same | Same | Duplicate of `/bills/policy` | **MERGE** (see `/bills/policy`) |
| `/receipts` | Review AI-extracted receipts · bookkeeper | Filters; 8-column table with ConfidenceBar and hover peek; DetailDrawer with no actions | Approve per row; bulk AI Categorize | Skeleton, error, empty | **No page permission check.** Silent 50-row cap. Headers "GL Category", "Conf.". | **MERGE**: becomes the receipts lane of To review |
| `/purchase-orders` | POs and 3-way match | 8-column list, create panel, wide drawer (lines, Receive, match panel) | Create PO, Receive goods, 3-way match with tolerance % | Spinner, error, empty | Own `Drawer` (line 528). Comments still reference `/exceptions` and "GATE 11b". | **KEEP**, move to the shared drawer |
| `/checks` | Pay runs (check and ACH) · AP, approver, releaser | 3 stat tiles; **5-step progress bar** (Queue, Capture, Review, Export/mark, Release); batch panel; origination panel; 6-column queue | Run, Approve (blocked for the preparer), Bill-pay CSV, NACHA file, check numbers, Release (`window.confirm`), remittance PDF, Originate | Spinner, empty | Naming: nav says "Pay Runs", page says "Check Run", route is `/checks`. Origination is "SANDBOX — no live rail". Copy like "DR A/P / CR …". | **KEEP**. Rename route to `/pay-runs`; replace the native confirm. |
| `/payroll` | Payroll register to journal entry; runs · HR/payroll | Provider BuildStatusBadge; 4 tiles; sortable runs table; run DetailDrawer; run wizard; PDF and CSV register imports | Import register (AI PDF, or CSV with saved column maps), "Run payroll (estimate)", approve, release, remit | Spinner, error, empty | Wizard uses flat placeholder rates (about 18%/9%) on the mock provider, labelled as an estimate. Each import modal has its own company picker. The two importers overlap (544 and 689 lines). Run drawer's GL link uses `?entry=`, which is ignored. | **KEEP**; remove the duplicate pickers and fix the link |
| `/vendors` | Vendor master · AP | Search, 1099 toggle, 7-column sortable table, W-9/COI badges, inline form with duplicate warning, DetailDrawer with W-9/COI parse and vendor portal access | New/Edit, parse W-9/COI | Spinner, hand-built empty state; a load error is likely never shown | **No page guard and no CompanyScopeGuard.** `vendor-list.tsx` and `vendor-peek.tsx` are dead code. Uses zinc colours where the rest of the app uses slate. Own `<h1>`. | **REWORK**: fix guard, error state and palette; restore hover peek |
| `/vendor-compliance` | W-9/COI, payment holds, overrides | Tabs Compliance / 1099 Readiness; 8 summary cards; filter chips; table with an "AI risk" column; Grant-override modal | AI compliance sweep, grant override, end override (`window.prompt`) | Spinner, error, empty | No page permission check | **KEEP**; add a guard |
| `/compliance-1099` | 1099 NEC/MISC by tax year | Year selector, NEC/MISC filter, 8-column table, generate modals | Flag vendor for a W-9 chase, generate, e-file export | Spinner, error | No CompanyScopeGuard even though 1099s are filed per payer company. The two generate modals are near-duplicates. | **KEEP** as a tab; add company scope |
| `/retainage` | Retainage payable | 3 cards, 7-column table, Release modal | Release & pay | Spinner, error, empty | **No page permission check on a payment action.** Off-nav. | **KEEP** as a Bills tab; add a guard |

#### Receivables

| Route | Purpose · roles | Components | Workflows / keys | States · data | Issues | Rec |
|---|---|---|---|---|---|---|
| `/invoices` | Customer invoicing · AR clerk | Pills Invoices / Recurring / Credit memos / Unapplied payments; 4 metric cards; hover peek; drawer with ExplainPanel (on invoice and payment) and attachments | New, Import from contract (AI), Receive payment, Send/Resend, PDF, copy pay link, credit memo, Edit with override, Void/Write-off (reason required), recurring Generate now / pause | All states · live API | "Collections & DSO" button links to the stub `/invoices/collections`. **"Unapplied payments" tab is a TODO placeholder** that links to the stub `/cash-application`. Own `<h1>`, gray palette, 872 lines, redundant "All Companies" dropdown. | **REWORK** |
| `/estimates` | Quotes pipeline | 4 cards (pipeline, won, win rate, all), pills, sortable table, drawer | Mark sent / Accept / Decline / Expire, PDF, Convert to invoice | All states | "Mark sent" only changes status; estimates have no email route. Own `<h1>`. | **KEEP**; add sending |
| `/collections` | Collector worklist · AR | Tabs Aging / Risk & Cadence. Aging: cards with DSO, aging bar, Worklist / By customer, Remind. Risk: predicted pay date with confidence, AI dunning draft then approve and send, promise-to-pay | As listed | Loading, error | **Two dunning paths** (direct remind vs AI draft then approve). Two company dropdowns. | **REWORK**: one dunning path |
| `/customers` | Customer master and dossier | Search, inline form, hover peek, drawer with dossier (risk, payment behaviour, credit), statements (preview/email), merge, portal access, invoice text and entity settings | As listed | Basic loading and error | **No page guard and no CompanyScopeGuard.** Zinc palette, raw fetch. | **REWORK**: add guard |
| `/customer-deposits` | Retainers held as liability (2420) | Cards, AR tie-out card, status tabs, posting-preview modal (Dr/Cr), drawer | Record, Apply to invoice, Refund | All states · guard `invoices:view` | Duplicates the tie-out card pattern; 811 lines | **KEEP** |
| `/rev-rec` | Revenue recognition · controller | Tabs Run / Accrue unbilled / Reports; Reports has Deferred rollforward / Waterfall / By method; hover peek on jobs | Post recognition, Post accruals (`window.confirm`) | Loading, error | No server guard. Tabs aren't in the URL. | **KEEP**; add guard and `?tab=` |

#### Banking & cash

| Route | Purpose · roles | Components | Workflows / keys | States · data | Issues | Rec |
|---|---|---|---|---|---|---|
| `/bank-feed` | The bookkeeper's main review queue | Tabs Bank Feed / Credit Cards / Apply Deposits (`?tab=`); feature list below the table | `j`/↓, `k`/↑, `a` approve, `e` edit, `f` flag, Space select, Esc. Keys are ignored while typing or with a modal open. | Skeleton, error, empty · live API; guard only | See list below | **KEEP**: becomes the core of S3 |
| `/reconciliation` | Bank reconciliation · bookkeeper (prepares), controller (signs off) | Tabs Autopilot / Statement / AR↔GL Tie-Out (tabs not in the URL); feature list below the table | Esc layered (closes memo, then workspace) | All states | Workspace file is 1599 lines (largest file in the app). Statement tab has a redundant company dropdown. | **KEEP** the workflow, split the file |
| `/cash` | Cash position and 13-week forecast · CFO | Tabs Position / Forecast; health chips; hand-drawn trend; 30/60/90 obligations; driver forecast with low-water mark | Refresh, bank connect | Loading, error | **Two different 13-week forecasts on one route** (`/api/forecast/cash` vs `/api/forecast`). Description says "across all entities" but the page is locked to one company. | **REWORK**: one forecast |
| `/debt` | Debt register and covenants · CFO/controller | Tabs Debt & Loans / Covenant Monitor; instrument cards; AI loan-document parse then review; schedule drawer; covenant bands, headroom, projected breach | Post accrual/payment, Reset rate / Refinance / Payoff with before/after preview, compliance certificate draft, Delete (warns GL entries are not reversed) | All states | Obligations' `/covenants?focus=` link loses `focus` in the redirect | **KEEP** |
| `/borrowing-base` | Borrowing-base certificate · CFO | Editable advance rates and haircuts, browser-side calculation, export xlsx/csv/pdf | Export | All states | Certificate is calculated in the browser. No server guard. Consolidated view allowed via `canConsolidate`. | **KEEP**; move the calculation to the server |
| `/obligations` | Renewals and obligations calendar | 5 metrics; type filters (9 types); horizon; sections ordered by urgency with links to the source record | Refresh | All states · guard `reports:view` | Overlaps the Cash obligations panel and the Subscriptions Renewals tab | **KEEP** (the source of `bk.agenda`) |
| `/subscriptions` | Catch subscription creep | Tabs Overview / Price creep / Renewals / Triage / All | Scan, AI parse, Keep / Review / Flag to cancel (drafts a request) | All states | — | **KEEP** |

**`/bank-feed` features:**
- Header actions: Refresh (Plaid sync), Import statement (PDF), AI Categorize.
- Status tabs with count and $ total; search waits 300 ms after typing.
- Refine bar: bands High / Med / Low / Uncoded with counts, vendor filter, saved views stored in the browser per org and company (`bank-feed-views.ts`, unit-tested).
- Duplicate banner and "Possible duplicate" badge.
- Metrics strip: reviewed today X/Y, auto-approved count, average confidence.
- Sortable columns; lowest confidence first by default.
- Inline GL and job pickers. COGS rows can't be approved without a job.
- **Confidence explainer** (`confidence-explainer.tsx`): the vendor/amount/date score breakdown and the auto-approve checks.
- Batch: select by band, click a vendor to select its rows, running total, Batch Approve. Batch sends one request after another, so it is slow.
- Edit panel (`edit-panel.tsx`, 983 lines): eligibility checks, score breakdown, AI reasoning, ExplainPanel, GL search grouped by type with **"Recent for this vendor"**, **vendor memory**, department/class enforcement, Save & Approve, opens directly from `?id=`.
- Flag requires a reason.
- Statement import wizard: checks the lines against opening and closing balances.
- Credit Cards tab: receipt badge (Matched / Missing / "Chase N"). **Flag button is dead** ✔ (`credit-card-feed.tsx:271` only stops the click). No edit, no batch, no keys.
- Apply Deposits tab: AI cards matching a deposit to invoices, with an over-apply guard.

**`/bank-feed` issues:**
- **Edits to the vendor name are thrown away** ✔: `vendorName` is never sent with the approve request.
- Auto-approve limits (85% and $10,000) are hardcoded in the list (lines 44–45) instead of read from org settings.
- `company-selector.tsx` is dead code.
- The score-bar code is duplicated in two files.

**`/reconciliation` features:**
- **Autopilot:** a tier per line (Auto / Review / Escalate), Accept/Reject, "Auto-clear N".
- **Workspace:**
  - Statement drop that sets the ending balance and auto-clears matches.
  - Running tie-out.
  - **Difference decomposer** waterfall and aging bands (`reconciliation-analytics.tsx`).
  - Unexplained variance is shown and **never auto-plugged**.
  - Stale items.
  - AI adjusting-entry proposals and a manual adjustment with a duplicate-post guard key.
  - AI memo.
  - History, Unreconcile.
  - **Finalize & lock, disabled until the difference is $0.**
  - **Override with reason** (8–500 characters, only with the capability).

#### Accounting

| Route | Purpose · roles | Components | Workflows / keys | States · data | Issues | Rec |
|---|---|---|---|---|---|---|
| `/journal-entries` | Manual JEs and the recurring JE workflow · accountant/controller | Tabs Entries / Recurring; status pills; 10-column table; **hover peek with a mini Dr/Cr ledger**; `je-drawer` (lines, balance check, Explain, Attachments, Edit); opens from `?id=` | Compose with AI, New Entry (Post immediately). **Editing a posted entry requires an override reason** (reverses, re-posts, writes the audit log). Recurring: New template, Generate due, approval queue (Approve & post / Skip), Pause/Resume/Cancel. | All states · guards `journal_entries:view` + scope | Drafts have no Post button in the drawer, and there's no Void/Reverse button | **KEEP**; add those drawer actions |
| `/recurring` | **Old** recurring JE register (`recurring_templates`) | Read-only table | none | Spinner, error, empty with a call to action but no button | **A second recurring-JE engine is live** (`lib/posting/recurring-engine.ts` via `/api/period-engine` and `missed-accruals.ts`). Off-nav; still registered in `permissions.ts:536`. | **RETIRE** after migrating its templates. Redirect to the JE Recurring tab. |
| `/chart-of-accounts` | Accounts and new-account approval · controller/admin | Tabs All / Pending; Grouped / List; balances by month/year; hover peek; AccountDrawer; GL detail modal; Request Account | Approve/Reject pending | Spinner, error, 3-way empty state | No page guard. **Approve/Reject never checks the response**, so a failure is silent. `account-tree.tsx` is dead code. | **KEEP**; fix the silent failure |
| `/assets` | Link hub (6 cards) | HubTabs | — | Static | Adds nothing beyond navigation | **MERGE**: hub tabs only, drop the card page |
| `/fixed-assets` | Asset register | Registry / Roll-forward; 3 KPIs; hover peek; AssetDrawer (method, units, schedule, dispose preview then confirm); Add from invoice (AI) | Dispose, add | All states | **No "run depreciation" action on the page.** `locationFilter` has no control. | **KEEP**; add the run action |
| `/leases` | ASC 842 leases | 4 metrics, expandable cards with schedules, upload (AI) | Record this month, Modify / CPI / Terminate, Delete | All states | — | **KEEP** |
| `/prepaids` | Prepaid amortization (`posting_schedules`) | Upload (AI), set up, per-row run | Run due, Cancel | All states | Copy lists insurance as a prepaid, but `/insurance` amortizes with **its own engine** | **KEEP**; decide on one engine |
| `/insurance` | Policy register and amortization (own tables) | Upload (AI), editor, renewals panel, premium summary | Amortize, Edit/Delete | All states | Second amortization engine | **MERGE** amortization into prepaids; keep the policy register |
| `/intangibles` | ASC 350 (stored in `fixed_assets`) | 4 metrics, slide-over | Run amortization, **impairment amount via `window.prompt` (posts a JE)** | All states | Mounts its own ToastContainer. Status values use fixed-asset terms. | **REWORK** the impairment dialog |
| `/internal-invoices` | Charges between departments | Status filters, hover peek, drawer | Send/Approve/Reject (reason), Void | All states | **"View GL" link uses `?highlight=`, which the JE list ignores** ✔ | **KEEP**; fix the link |
| `/departments` | Department hierarchy | Grouped table, hover peek, DeptDrawer, charge-method setting | Create/Edit, Deactivate | All states | — | **KEEP** (moves to Client settings) |
| `/tax` | Link hub (4 cards) | HubTabs | — | Static | — | **MERGE** (hub tabs only) |
| `/tax/sales-tax` | Worksheet + filing calendar | Tabs; quarter/month picks; Print/CSV; record filing | Record filing / Unmark | Empty | No guard. Inner views render their own PageHeader **below** the tabs. Calendar's "Worksheet" link goes to a stub and loses its dates. | **REWORK** |
| `/tax-depreciation` | Tax book (MACRS/§179/bonus) | Expandable schedules | Propose / Confirm to M-1 | All states | No guard | **KEEP** |
| `/book-to-tax` | M-1/M-3 and account tagging | 2 tabs | AI propose tags (with reasoning), accept, clear | All states | No guard | **KEEP** |
| `/tax-provision` | ASC 740 provision | Rollforward, rate reconciliation | Propose, Post JE (disabled in "all") | All states | Own location picker that allows "all" | **KEEP**; drop the picker |
| `/tax-package` | 1120-style package (read-only) | 6 KPIs, M-1, depreciation, provision; own entity/period/rate selectors | Download PDF | Error, empty | Re-displays three other screens | **KEEP** as the output view |
| `/documents` | Document centre | Upload with type, Unfiled view, filters, sort, bulk download | View/Download/Delete | All states | **No guard and no CompanyScopeGuard.** Description is about 60 words. | **REWORK** (guard) |
| `/periods` | Period grid (year × month × company) | Cell menu Open / Soft / Hard close | Reopen with a reason (`window.prompt`), "Generate year for all companies" (behind a one-company guard) | Skeleton, empty | Hard close here has **no override UI**; a gate block only shows a toast. `/close` has the override. | **MERGE** into Close (one period-control surface) |
| `/close` | Close command centre | Tabs Tasks / Status / Year-End; task graph with sign-offs; close-package XLSX; hard close with the gate listing blockers and an **override with audited reason**; status board; year-end preview, post, reverse | As listed | All states | Status tab says "across every entity" but needs one company. Year-end reverse uses `window.prompt`. | **KEEP**: becomes step 4 of S2 plus the `am.close_grid` source |
| `/jobs` | Jobs list | Status pills, pricing badge | WIP Schedule, WIP Report, New Job | Skeleton, empty | Form uses the gray palette | **KEEP** |
| `/jobs/[id]` | Job detail | Rev-rec method selector, ledger, EAC panel (3 methods, AI Explain), job P&L | Save method | — | No CompanyScopeGuard. The 3-method selector is repeated three times. | **KEEP** |
| `/jobs/wip` | WIP schedule (over/under billing) | 3-method toggle | — | — | Overlaps Reports `wip` | **KEEP**; link to the report |
| `/inventory` · `/[id]` · `/valuation` | Items, movements (Receipt/Issue/Adjust, Approve & post), valuation with GL tie-out | — | Export CSV | All states | `[id]` has no CompanyScopeGuard | **KEEP** |

#### Reporting and analytics

| Route | Purpose · roles | Components | Workflows / keys | States · data | Issues | Rec |
|---|---|---|---|---|---|---|
| `/reports` | About 32 reports in 6 groups | Left catalog; period presets; Companies/Industries multi-select; Accrual/Cash; GAAP/Tax/Cash/Custom basis overlay; Summary/Detail; compare modes; GL drill-down drawer; AI narrative; **saved views**; report compiler (describe a pack in plain English, get one PDF, ⌘↵); saved packs with schedule; export xlsx/csv/pdf; **remembers each user's settings per report** | As listed | All states | No page guard. Sidebar "Ask for any report…" input **does nothing**. `vendor_1099` and `sales_tax` show "not yet implemented". `pnl_dept` and `pnl_class` take no department/class parameter. `?location_id=` is ignored. 1105 lines. | **KEEP** the engine; **REWORK** the surface |
| `/reports/basis-adjustments` | Presentation-only basis adjustments | CRUD; Derive from Book-to-Tax | — | Loading, error | Description is about 90 words | **KEEP** |
| `/fpna` | FP&A dashboard · CFO/controller | **Configurable KPI grid** (16 metrics, layouts, show/hide, reorder, saved in localStorage); 2 SVG charts; variance table; plain-English what-if (⌘↵); refreshes every 120 s | Customize | All states | 971 lines. Layout lives in localStorage (IA M-8 replaces it). | **KEEP**: becomes CFO/finance-director widgets |
| `/budgets` | Budgets · finance | Tabs Plan / Driver Builder / Reforecast; Plan has a second tab row (Entry / BvA / Scenarios); import with dry-run; NL scenario bar | Import, scenarios | — | No guard. Two levels of tabs. In-page company picker can disagree with the header. | **REWORK** (flatten tabs) |
| `/profitability` | P&L per company | Focused / All toggle; KPIs incl. "Portfolio rank"; bar chart; sortable table | — | All states | Always fetches every company (`scope:false`). `/api/profitability` has no permission check. | **MERGE**: becomes workspace "Profitability by client" (`ow.clients_compare`) |
| `/consolidation` | Consolidation · controller/CFO | Tabs Statements / Intercompany / Ownership / FX rates / IC match; eliminations column, NCI, equity method, FX toggle | Ownership and FX CRUD (`window.confirm`); IC post and void (void reason via `window.prompt`, sent in the query string) | All states | **No guard on page or API** (IA R4). Duplicates Reports `consol`. Double padding. 1275 lines. | **REWORK**: becomes the consolidated context (S12) |
| `/board-package` | Board pack | Period presets, company multi-select, KPIs, AI summary, Excel/PDF | Generate/Download | Loading, error | "Operating Income" is mapped to `ebitdaCents` (around line 341), likely a mislabel. Re-implements Reports' controls. No guard. | **MERGE** into Reports packs |
| `/search` | Plain-English search page | Type chips, grouped results | — | All states | Duplicates the palette; ignores the active company | **RETIRE**: use the palette, plus a "see all results" view |
| `/ai-decisions` | Log of AI proposals | Status pills; cards with proposed lines, confidence, model, cost, clarifying question | **Reject only** (`window.prompt`), no Approve | Spinner, error, empty; not paginated | No guard. Jargon "Model:", "Metered: $0.0000". Overlaps the Inbox Exceptions tab. | **REWORK** as a read-only log; act in queues |
| `/categorize` | "AI Categorizer": type a description, post a JE | Form, proposed coding, entry preview | **Posts a JE immediately** (`post_immediately: true`) | Inline error | **No guard and no CompanyScopeGuard on a page that posts.** Jargon. | **RETIRE** (IA already folds it into To review). Keep `/api/categorize/learn`. |
| `/agents` | Supervised agent runs | Recipe step badges (Auto / AI Proposes / Human Gate), run history, timeline | Start (user must **type a raw `bill_id` UUID**), Approve/Reject at each human gate | Loading, error, empty | Jargon: "M10 dial-governed", "agent persistence tables not yet migrated". | **REWORK**: becomes "Done for you" and the gates in queues |

#### Team, oversight, settings, platform

| Route | Purpose · roles | Components | Workflows / keys | Issues | Rec |
|---|---|---|---|---|---|
| `/portfolio` ("Entities") | Board across companies · manager | 6 KPIs; tabs Board (red/amber/green filter) and Ownership (assignment matrix with inline selects); period stepper | Assign owners | No guard on page or API (IA R2). **Row links don't switch the active company**, so users land on the picker prompt. `/cash?location_id=` is ignored. 804 lines. | **REWORK** into `/clients` + `am.close_grid` |
| `/portfolio/[id]` | One-company snapshot | P&L vs prior, BS lines ("unmapped role" flag), close, AR/AP, exceptions | Cross-links whose query parameters are ignored | Same | **REWORK** into the client profile |
| `/team` | Directory, access, performance | Roster; invite/edit (role, company access, admin scope incl. `portcos_and_3rdparty`); pending invites; New company; Performance (7D–YTD, close and filing adherence) | Invite/Resend/Revoke | 1288 + 1046 lines. "New company" is a fifth add-company path. | **REWORK** (S11) |
| `/compliance` | Filings + Controls (SoD, autonomy posture, audit-trail completeness) | 2 tabs, each with its own PageHeader | Drill-downs | Shell title doesn't match the inner title. `compliance-grid.tsx` is **dead mock data** (`Math.random()`, "March 2026"). | **KEEP**; delete the dead file |
| `/audit` | Audit trail | Stat tiles; actor tabs Human / AI / System; filters; paged table; **TimelineDrawer** (record history); CSV export | — | Good | **KEEP** |
| `/pbc` | Auditor PBC requests | Status tabs with counts; filters | New, Assign, Attach (marks provided), Accept, Delete | No help entry | **MERGE** into Requests (IA M-7 view) |
| `/onboarding` (+ conversion, portfolio, reconciliation, sections, tour) | Setup wizard (7 steps), setup board, readiness checklist, smart intake, TB conversion with tie-out, Control Tower, role-aware tour | Wizard keys: ←/→/Home/End between tabs; tour ←/→/Esc | Sub-pages have no guard except `/onboarding/portfolio`. Rev-rec option list is duplicated in `new-entity-wizard.tsx`. Tour comment still says "placeholder". | **KEEP** (FPB-onboarding governs) |
| `/import` | Generic CSV import wizard (8 types, dry-run) | Type → Upload → Map → Review → Done | No page guard. Jargon "Suite Core layer". Trial-balance import overlaps conversion. | **KEEP** under Client settings / Add data |
| `/integrations/erp` | Connector catalog | Search, grouped by industry | **25 of 28 entries are PLANNED. QuickBooks Online is shown as PLANNED even though onboarding connects it live.** | **REWORK** |
| `/operations` | Machine-vs-human KPIs, client health, activity | Client-only `canManageUsers` check; `/api/operations` only needs a signed-in user. "Across the portfolio". | **MERGE** into workspace "Books health" (IA §3.7) |
| `/settings` | 10 tabs: Organization, Receipt Chase, AI Thresholds, Cost Routing, Revenue Recognition, Sales Tax Rates, Invoice Display, Learned Preferences, Companies, Danger Zone (reset/export) | Floating save bar | No page guard. AI Thresholds overlaps `/settings/autonomy`. | **REWORK**: split into tenant and client settings (see §3) |
| `/settings/approvals` | N-step approval workflows | Tabs Configure / **Visualize** / **Simulate** / **Coverage gaps** | Good | **KEEP** |
| `/settings/autonomy` | AI autonomy per capability (Off / Propose / Auto-under-limit) and a **kill switch that requires a reason** | — | Error copy says "control plane" | **KEEP** |
| `/settings/billing` | Plan, seats, cost | "Activate billing (coming soon)" disabled | — | **KEEP** (honest label) |
| `/settings/new-entity` | Add-company wizard | Identity / Fiscal / Confirm | One of five add-company paths | **MERGE** into "Add client" |
| `/settings/payments` (+refresh, return) | Stripe Connect | Inline styles on the stubs | — | **KEEP** (Client settings) |
| `/settings/roles` · `/settings/permissions` | Feature × action grid, custom roles, external auditor invite | Same component (982 lines) | `/permissions` is an exact alias | **RETIRE** `/permissions` (redirect) |
| `/platform` | Operator console | 6 KPIs, tenant table, growth chart, FeeRevenueReport, OpsHealth | Two "Soon" cards. **"Companies" column sorts by MRR** (`operator-dashboard.tsx` around line 354). | **REWORK** (S9) |
| `/sandbox` | Seed / round-trip / reset | Not in nav, no page guard (API needs `ALLOW_SANDBOX=1`) | — | **KEEP**, platform-only |

---

## 2. Patterns worth keeping (with code paths)

| # | Pattern | Where it lives | Why keep / notes for the port |
|---|---|---|---|
| 1 | **DetailDrawer**: one slide-over for any record that returns you to your place in the list | `components/detail-drawer.tsx`; used by JE, expenses, receipts, payroll, vendors, invoices, estimates | It is the app's single detail pattern. Move Bills (`bill-detail.tsx`) and POs (`po-client.tsx` `Drawer`) onto it. S3's edit panel matches it. |
| 2 | **Hover-peek cards**: interactive preview (mini invoice, JE T-account, receipt image) with an "Open full" button | `components/hover-peek.tsx`; `journal-entries/je-peek.tsx`, `bills/bill-peek.tsx`, `invoices/invoice-peek.tsx`, `receipts/receipt-peek.tsx`, `customers/customer-peek.tsx` | Unusual, high value for dense queues. Not in any S-screen; add it to the component sheet. |
| 3 | **ExplainPanel**: "Explain this ___". Facts are gathered deterministically; the AI only writes the wording. | `components/explain-panel.tsx`, `/api/explain` | The honest version of AI explanation. Use it everywhere. |
| 4 | **Confidence bands, bars and explainer** (vendor/amount/date breakdown plus auto-approve checks) | `components/ui/confidence-bar.tsx`, `bank-feed/bank-feed-refine*.ts(x)`, `bank-feed/confidence-explainer.tsx` | S3's Decide / Check / Ready is the same idea. Keep the "why this confidence?" modal; S3 doesn't show it. |
| 5 | **Bank-feed keyboard flow** (`j`/`k`/`a`/`e`/`f`, Space, Esc; ignored while typing or with a modal open) | `bank-feed/bank-feed-content.tsx` (~line 570) | S3 uses J K X A F E Q ⇧A. **Keep Space as an alias for X** so existing muscle memory still works. |
| 6 | **List keynav hook** (j/k/Enter plus a secondary key; safe in inputs) | `inbox/use-list-keynav.ts` | Make it the one hook for every queue. Today only Inbox and Bank Feed have keys. |
| 7 | **Saved views** (bank feed: per org and company; reports: named views) | `bank-feed/bank-feed-views.ts`, `use-bank-feed-views.ts`; `reports/saved-views.tsx` | Move storage to the server (alongside M-8). S3 drops them; they need to come back. |
| 8 | **Vendor-batch and band-batch select, running total of the selection** | `bank-feed/bank-feed-list.tsx` | S3 keeps ⇧A for Ready only. **Click a vendor to select its rows is missing.** |
| 9 | **GL search with "Recent for this vendor" plus vendor memory ("you usually code this to…")** | `bank-feed/edit-panel.tsx`, `/api/learning/vendor-memory` | A CLAUDE.md requirement. S3 shows vendor memory; make sure the recents list survives. |
| 10 | **Privileged override with audited reason** | JE posted-edit (`journal-entries/je-drawer.tsx`); hard-close gate (`close/close-grid.tsx`); reconciliation finalize (`reconciliation-workspace.tsx`, 8–500 characters, capability-gated); autonomy kill switch (`settings/autonomy`); vendor-compliance override; invoice void/write-off; flag reason | One `OverrideReasonDialog` component should replace every `window.prompt` (§5). |
| 11 | **Never auto-plug + Finalize disabled until $0 + difference decomposer** | `reconciliation/reconciliation-workspace.tsx`, `reconciliation-analytics.tsx` | This is S2 step 2. Port the waterfall as-is. |
| 12 | **Tie-out panels** (subledger vs GL control) | `cash-application/cash-application-parts.tsx` `TieOutCard`; deposits tie-out; inventory valuation tie-out; `components/onboarding/tie-out-banner.tsx` ("Balanced to the penny") | Merge into one `TieOut` component. S2 step 3 lists AR/AP tie-out, so it should render this card. |
| 13 | **Preview before post** (Dr/Cr preview; before/after) | deposits modal; debt reset/refinance/payoff; fixed-asset dispose; year-end preview; statement import balance check | Core trust pattern; standardize it. |
| 14 | **AI parse → review → confirm** document intake | leases, debt, fixed assets, insurance, prepaids, subscriptions, W-9/COI, payroll register, contracts → invoices, statements | Same three-step shape everywhere. Make it one `ParseReview` shell. |
| 15 | **⌘K command bar** (plain-English route to process / analyze / navigate, pinned questions, "AI proposes · you approve") | `components/nl/command-bar.tsx`, `nl/intent.ts` | IA keeps ⌘K and adds ⌘J. Fix the double binding first. |
| 16 | **AiUnavailableNotice**: a calm pause, never a crash | `components/ai/ai-unavailable-notice.tsx` | It is exactly IA §4.0 rule 8, already built. |
| 17 | **ApprovalChainStatus** on a document (whose turn it is, reject needs a reason) and **PaymentFraudCard** (clear / review / block verdict) | `components/approvals/approval-chain-status.tsx`, `components/controls/PaymentFraudCard.tsx` | Feed `cfo.release` and `ow.decisions` ("fraud-screen flags inline"). |
| 18 | **AttachmentsPanel** on any record | `components/documents/attachments-panel.tsx` | Keep. |
| 19 | **Segregation of duties in the UI** (preparer can't approve; submitter can't approve) | `checks/checks-client.tsx`, `expenses/expenses-client.tsx` | Keep the disabled state together with its reason. |
| 20 | **Pay-run 5-step progress bar** | `checks/checks-client.tsx` | Same shape as the books-review stepper; reuse it. |
| 21 | **`?tab=` section tabs + redirect stubs for retired routes** | `_components/section-tabs.tsx`, `_components/hub-tabs.tsx` | Good migration pattern for the `/portfolio` → `/clients` renames. Apply it to Reconciliation, Rev-rec and Collections, which don't put the tab in the URL. |
| 22 | **Configurable KPI grid** (show/hide, reorder, layouts) | `fpna/fpna-dashboard.tsx` | An early version of IA §5 customization; reuse its interactions. |
| 23 | **Approval workflow simulator / visualizer / coverage gaps** | `settings/approvals` | Unusual and strong; keep it whole. |
| 24 | **Inbox mechanics**: snooze, recently resolved, "N sources skipped" honesty, same count as the bell | `inbox/inbox-client.tsx`, `exceptions-queue.tsx`, `layout/notifications-bell.tsx` | Feeds `am.review_queue`, `ow.decisions`. |
| 25 | **Audit TimelineDrawer** + actor tabs Human / AI / System | `audit/audit-client.tsx` | Becomes `au.audit_trail`; and "history" on every record. |
| 26 | **Obligations by urgency, each row linking to its source** | `obligations/obligations-dashboard.tsx`, `lib/obligations/collect.ts` | The natural data source for `bk.agenda`. |
| 27 | **Collections intelligence**: predicted pay date with confidence, AI dunning draft → approve → send, promise-to-pay | `collections/collections-workflow.tsx` | Keep this path; retire the direct "Remind" path. |
| 28 | **Honest build-status labels** | `components/brand/build-status-badge.tsx` (payroll provider, billing "coming soon") | Matches IA's "list-price computed" honesty rule. |
| 29 | **Per-user report preferences ("remembers how you run this report")** | `reports/report-viewer.tsx`, `/api/learning/preferences` | Keep. |
| 30 | **Front-door resolver** | `lib/onboarding/flow` | Re-point its targets per IA §3.2. |

---

## 3. What the IA-SPEC or the v2 screens would lose or bury

These are capabilities that are live today with no stated home in IA-SPEC §3–§4 or in S1–S12.

1. **Inbox inside a client.**
   - §3.6's client nav has no Inbox. Its Home group is Client home / To review / Requests / Close.
   - Today Inbox Approvals / Alerts / Drafts work per company. Bill and JE approvals and draft JEs a bookkeeper left behind need a home inside the client: add Inbox to the client Home group, or make it a step 3/4 lane.
2. **Apply Deposits (cash application).**
   - It is a bank-feed tab today. It does not appear in §3.6, the S2 step list, or S3 (which merges Bank and Ramp only).
   - Add it as a To review lane, or put it under Receivables, otherwise deposits stay unapplied.
3. **The `/invoices` "Unapplied payments" tab** is already a TODO. The redesign should give unapplied cash one home together with item 2.
4. **Expense approvals and reimbursement batches.**
   - `/expenses` has an Approver Queue and a Reimbursement Batch. Only `dh.approvals` mentions expenses, and bookkeepers and AP have no reimbursement module.
   - Add them to the Review queue (`am.review_queue`) and to `pc.queue`.
5. **The v2 client sidebar in S2/S3 shows about 13 items.** If it's built literally, about 28 live destinations disappear:
   - Payables and receivables: Expenses, POs, Payroll, Vendor compliance, Estimates, Collections, Customer deposits, Rev-rec.
   - Banking and cash: Cash position, Borrowing base, Obligations, Subscriptions.
   - Accounting: Assets & schedules, Internal invoices, Departments, Tax, Documents, Fiscal periods.
   - Jobs: Jobs, WIP, Inventory.
   - Reporting: FP&A, Budgets, Board package, Search, AI decision log, Agents, Basis adjustments.
   - §3.6 keeps them, so the design should show the full grouped nav, or a "More" pattern driven by permissions and tenant features.
6. **Bank-feed features S3 doesn't show:**
   - Saved views; vendor filter and click a vendor to batch-select.
   - Sortable columns (S3 fixes the sort to confidence).
   - Refresh / Import statement / AI Categorize header actions.
   - Job picker and the "COGS needs a job" rule.
   - Department/class enforcement.
   - The confidence-explainer modal; the flag-reason dialog.
   - The metrics strip ("reviewed today X/Y").
   - The Credit Cards receipt-chase badge.
   - All are in CLAUDE.md's required Bank Feed list; S3 needs them before build.
7. **Ad-hoc multi-company reporting.**
   - Today Reports, Board package, Borrowing base and Profitability accept any multi-select of companies (and an "Industries" filter).
   - IA §1/§7 R4 puts every roll-up behind a named group plus a grant.
   - **Decision needed:** allow *side-by-side* (not summed) comparison across the clients you can access without a group, and require a group only for summed or eliminated statements. Otherwise owners and controllers lose the Industries/compare views they have now.
8. **Settings tabs with no mapped home.** §3.5 Tenant settings and §3.6 Client settings don't place these:
   - Receipt Chase, AI Thresholds (merge into Autonomy), Cost Routing, Revenue Recognition defaults, Sales Tax Rates, Invoice Display/branding per company, Learned Preferences, Companies, Danger Zone (tenant reset/export).
   - Also Payments (Stripe Connect), Import Data, Historical Conversion, Get Started.
   - Most are per-client and belong in Client settings. Reset/export and Learned Preferences are tenant-level.
9. **Compliance & Controls, Audit Trail, PBC.**
   - §3.5 has no slot for Compliance & Controls (filings, SoD, autonomy posture) or for the Audit Trail. Audit Trail appears only as `au.audit_trail`.
   - PBC is folded into Requests; that works only if `v_requests_all` ships with M-7.
   - Add a "Controls" item to the workspace Work or Insights group.
10. **Retainage, AP/expense policy, 1099.** Today they are reachable only as Bills or Vendor-compliance tabs, and §3.6 doesn't list them. Keep them as tabs, but say so in the spec so they aren't dropped.
11. **Supervised agents with human gates (`/agents`)** sit under "Reports" in §3.6. They belong with `bk.done_for_you` and the queues. Keep the AUTO / PROPOSE / HUMAN_GATE step timeline as the "why" behind each auto-posted item.
12. **Platform fee revenue and ops health.** S9's Revenue group (Plans & billing, Billing exceptions) and Health group don't include `FeeRevenueReport` (realized processor fee from `invoice_events`). Keep it under Revenue.
13. **Hover peek, ExplainPanel and AttachmentsPanel** don't appear in any S-screen or in `components.html`. Add them to the component sheet before the port, or the port will leave them out.
14. **The per-company tile board's "click a count → pin company + open that queue"** (`/dashboard`). `bk.my_clients`'s "Start [client]" covers part of it. Keep the per-count deep links (to review / attention / proposals / draft JEs) on the client rows.
15. **Year-end close and period reopen** (with reason) live in `/close` Year-End and `/periods`. `ctl.periods` covers hard close only; make sure reopen and year-end are reachable from the controller home.

---

## 4. Duplicated or overlapping pages to merge

| Overlap | Today | Merge to |
|---|---|---|
| Recurring JEs | `/recurring` (old `recurring_templates`, read-only, but its engine still runs from `/api/period-engine` and `missed-accruals.ts`) vs the JE Recurring tab (`recurring_je_*`) | Migrate templates, point `missed-accruals` at the new store, retire `/recurring` and the old engine, redirect to `/journal-entries?tab=recurring` |
| Prepaid insurance amortization | `/prepaids` (`posting_schedules`) vs `/insurance` (own schedules and runs) | One amortization engine; insurance keeps only its policy register |
| Document → bill (4 paths) | Auto-file, New Bill AI parse, Intake queue, Agents "AP Invoice Intake" | One intake pipeline that feeds the "Draft bills" lane |
| AI proposals (3 places) | `/ai-decisions` (reject only), Inbox Exceptions (dismiss), dashboard "Proposals" | Act in queues; `/ai-decisions` becomes a read-only log |
| Policy compilers | `/bills/policy` ≈ `/expenses/policy` | One "Policies" surface with a doc-type switch |
| Dunning | Collections Aging "Remind" vs Risk "AI draft → approve → send" | Keep the draft-and-approve path |
| 13-week forecast | `/cash` Position (`/api/forecast/cash`) vs Forecast tab (`/api/forecast`) | One forecast (feeds `cfo.forecast`) |
| Obligations | `/obligations`, Cash obligations panel, Subscriptions Renewals | `/obligations` is the source; the others embed it |
| Tie-out cards | `TieOutCard`, deposits tie-out, inventory tie-out, onboarding banner | One `TieOut` component |
| Period control | `/periods` hard close (no override) vs `/close` hard close (override) | Hard close only via the Close gate; `/periods` becomes a read-only grid plus reopen |
| Consolidated statements | Reports `consol` vs `/consolidation` Statements | Consolidated context (IA §3.1) |
| Budget vs actual (3) + NL scenario (2) | Reports `bva`, Budgets BvA, FP&A variance; `fpna-nl-scenario.tsx` vs `budgets/nl-scenario-bar.tsx` | One BvA view and one scenario component |
| Board packs | `/board-package` vs Reports compiler and saved packs | Reports → Packs |
| Per-company performance (3) | `/profitability`, `/portfolio` + `[id]`, `/operations` client health | Workspace Insights: Books health, Profitability by client; client profile |
| Search | `/search` page vs header palette (vs ⌘K) | Palette (⌘/) + command bar (⌘K); retire the page |
| Add a company (5) | `/settings/new-entity`, Settings → Companies, Team "New company", onboarding Company step, `/onboarding/portfolio` Add companies, (+ `/import` Companies) | IA "Add client" / "Add clients (bulk)" |
| Trial-balance intake (4) | `/import` TB, `/onboarding/conversion`, portfolio TB drop, SmartIntake | Conversion (with tie-out gate) only |
| Roles | `/settings/roles` = `/settings/permissions` | Redirect `/permissions` |
| AI thresholds | Settings → AI Thresholds vs `/settings/autonomy` | Autonomy |
| ERP / QuickBooks | Catalog says QuickBooks is PLANNED, onboarding connects it live | One integrations registry |
| Hub card pages | `/assets`, `/tax` (static cards that repeat child descriptions) | Hub tabs only |
| Tax package | `/tax-package` re-shows book-to-tax, depreciation, provision | Keep as the output view; remove its own pickers |
| WIP (3) | `/jobs/wip`, Reports `wip`, the per-job 3-method selector | One WIP view; one shared method selector |
| Company pickers inside pages | Invoices, Collections (×2), Reconciliation Statement, Cash, forecast grid, payroll importers, tax-provision, tax-package, categorize, budgets | Remove all of them; the context switcher is the only picker (IA R8) |
| Redirect stubs (17) | listed in §1.1 | Keep one release, then delete; fix the links that still target them (next row) |
| Links into stubs | `/exceptions` (dashboard, PO comments), `/invoices/collections` (`invoice-manager.tsx:119`), `/cash-application` (`invoice-manager.tsx:862`, `lib/explain/assemble.ts:712`), `/covenants?focus=` (`lib/obligations/collect.ts:413`, focus dropped), `/sales-tax-return?start_date=` (dates dropped), `/credit-cards` and `/forecast` in `permissions.ts:514,531` | Point at the real tab URLs |

---

## 5. Bugs and quality issues found (report only, not fixed)

**Live/console/network:** see §L for the signed-in pass (confirmed bugs, new bugs L1–L21). Original note: The only observed behaviour is that
`/dashboard` and `/` redirect to the Clerk dev sign-in page.

### Functional bugs (from code; ✔ = re-verified by hand)

1. ✔ **Bank-feed edit panel discards vendor-name edits.** `vendorName` is never sent with the approve request (`bank-feed/edit-panel.tsx`).
2. ✔ **Credit Cards Flag button does nothing.** Its handler only stops the click (`credit-cards/credit-card-feed.tsx:271`).
3. ✔ **⌘K opens two overlays at once** (`header.tsx:43` and `command-bar.tsx:75`).
4. ✔ **The sidebar's "CPA Desk ⌘K" button has no handler** (`sidebar.tsx:153`).
5. ✔ **Internal-invoice "View GL" link uses `?highlight=`**, which the JE list ignores. The payroll run drawer uses `?entry=`, also ignored.
6. **Chart-of-accounts Approve/Reject never checks the response**, so a failure is silent.
7. **Bills and Receipts lists are capped at 50 rows with no paging**, and nothing tells the user.
8. **Reports sidebar input "Ask for any report…" does nothing.** `vendor_1099` and `sales_tax` show "not yet implemented". `pnl_dept` and `pnl_class` ignore department/class.
9. **Board package: "Operating Income" is bound to `ebitdaCents`** (likely mislabelled).
10. **Platform tenant table: the "Companies" column sorts by MRR.**
11. **Links from Portfolio and the company snapshot don't switch the active company.** Users land on the picker prompt; `?location_id=` is ignored by `/cash` and `/reports`.
12. **Invoices "Unapplied payments" tab is a TODO placeholder.**
13. **`/periods` hard close has no override path.** A gate block only shows a toast.
14. **Auto-approve limits are hardcoded** in `bank-feed-list.tsx:44-45` instead of read from org settings.
15. **Batch approve and "Auto-clear N" send one request after another** (slow on 200+ items).
16. **Two recurring-JE engines and two insurance-amortization engines are live** (see §4). This risks double-posting or missed accruals.

### Access issues (overlap with IA §7)

These pages have **no page-level permission check**:
- Pages that post or move money: `/categorize` (posts JEs, and also has no CompanyScopeGuard), `/retainage` (releases payments).
- Other pages: `/dashboard`, `/ai-decisions`, `/receipts`, `/vendors`, `/vendor-compliance`, `/customers`, `/chart-of-accounts`, `/documents`, `/rev-rec`, `/reports`, `/budgets`, `/board-package`, `/search`, `/import`, `/settings`, `/sandbox`, `/onboarding/*` sub-pages, `/tax*`.
- Pages and APIs with no permission check at all: `/consolidation`, `/portfolio` (+ `[id]`), `/profitability`, and their APIs.
- `/operations` is checked only in the browser.

These pages have no CompanyScopeGuard: intake queue, 1099, vendors, customers, documents, `jobs/[id]`, `inventory/[id]`.

### Quality and consistency

- **Native dialogs for reasons, amounts or confirmations.** Several of these post to the GL.
  - `window.prompt`: ai-decisions, expenses (×2), vendor-compliance, intangibles impairment (an amount!), intercompany void (reason sent in the query string), period reopen, year-end reverse.
  - `window.confirm`: checks release, rev-rec, consolidation, PBC, sandbox.
- **Three colour palettes** (slate / gray / zinc). Several pages build their own `<h1>` instead of `PageHeader`, so they lose the active-company chip and help button: Invoices, Estimates, Vendors, Customers, Agents, Intake queue.
- **Tabs that aren't in the URL:** Reconciliation, Rev-rec, Collections (own implementation).
- **Jargon in the UI:**
  - "Entities", "Portfolio rank", "portfolio" (help, operations, onboarding).
  - "GL Category", "Conf.", "Uncoded", "composite", "AI bar".
  - "M10 dial-governed", "bill_id (uuid…)", "agent persistence tables not yet migrated".
  - "Azure OCR", "schema-validated ruleset (config, never code)", "Suite Core layer", "control plane", "Model:/Metered:", "DR A/P / CR …", "SANDBOX — no live rail".
- **Over-long page descriptions:** documents (about 60 words), basis adjustments (about 90 words).
- **Files over 800 lines:**

  | File | Lines |
  |---|---|
  | `reconciliation-workspace.tsx` | 1599 |
  | `team-client.tsx` | 1288 |
  | `consolidation/page.tsx` | 1275 |
  | `report-viewer.tsx` | 1105 |
  | `onboarding-wizard.tsx` | 1092 |
  | `performance-panel.tsx` | 1046 |
  | `bank-feed/edit-panel.tsx` | 983 |
  | `roles-client.tsx` | 982 |
  | `fpna-dashboard.tsx` | 971 |
  | `expenses-client.tsx` | 951 |
  | `invoice-manager.tsx` | 872 |
  | `bank-feed-content.tsx` | 839 |
  | `deposits-manager.tsx` | 811 |
  | `portfolio/page.tsx` | 804 |

- **Dead code:** `compliance/compliance-grid.tsx` (mock data with `Math.random()`), `vendors/vendor-list.tsx` + `vendor-peek.tsx`, `chart-of-accounts/account-tree.tsx`, `bank-feed/company-selector.tsx`.
- **No charts in Payables and Receivables at all.** Elsewhere there are a few hand-drawn SVGs (cash trend, FP&A, profitability, platform growth) with no shared chart component.
- **Design-system conflict:** CLAUDE.md describes emerald on dark with Plus Jakarta Sans and JetBrains Mono; v2 uses Electric Blue on Warm with Syne and DM Sans, square geometry, and amounts not coloured by debit/credit. The v2 README already flags this. Resolve it before the port, so builders aren't working to two specs.

---

## 6. Recommendations in priority order

1. **Before the design is built:**
   - Add the §3 items to IA-SPEC §3.6/§3.5 and the S-screens: Inbox in the client, Apply Deposits, expense approvals, full client nav, settings mapping, Controls/Audit slot, ad-hoc compare decision.
   - Add hover peek, ExplainPanel, AttachmentsPanel, TieOut and the override-reason dialog to `components.html`.
2. **Fix-now bugs, independent of the redesign:** §5 items 1–7, plus the access gaps on `/categorize` and `/retainage`.
3. **Collapse the duplicate engines** (recurring JEs, insurance amortization) before the books-review loop starts counting their output in "Done for you".
4. **Retire in the redesign:** `/search`, `/categorize`, `/recurring`, `/settings/permissions`, the `/assets` and `/tax` card pages, every in-page company picker, and the 17 stubs after one release.
5. **Finish this audit live:** owner signs in, then a chrome-auditor pass captures screenshots of the ~25 key pages listed in §7, plus console and network, the "All companies" state, and switching between companies.

## 7. Live pass still to do (target list for screenshots)

`/dashboard` (All + one company) · `/inbox` · `/bank-feed` (all three tabs, edit panel, explainer) · `/reconciliation`
(Autopilot, workspace, decomposer) · `/close` (Tasks with a gate block, Status, Year-End) · `/journal-entries` (drawer,
peek, Recurring) · `/bills` (+ intake queue) · `/checks` · `/expenses` · `/invoices` · `/collections` · `/cash` · `/debt` ·
`/reports` (P&L with drill + saved view) · `/fpna` · `/consolidation` · `/portfolio` · `/team` · `/settings` ·
`/settings/approvals` (Simulate) · `/settings/autonomy` · `/onboarding` · `/platform` · `/vendor-compliance` · `/payroll`.

---

## §L Live walkthrough (2026-10-19, signed in)

**Result: done.** The owner signed in to `meritbooks-web.vercel.app` (Clerk **dev** instance) and the pass ran
read-only in tab 526063231. Nothing was approved, posted, sent, saved, dismissed or reconciled. The only state changed
was the active-company cookie (left on Northwind, where it started) and the plane switcher.

### L.0 Scope, data and method

- **Tenant seen:** org "Merit Management Group" (slug `revived-interiors`) with **3 companies**: `[SANDBOX] Coho Flooring`
  (CHF, most data), `[SANDBOX] Northwind Construction` (NWC, one $150K AR invoice) and `Acme Test Co` (ATC, 48 AI
  proposals). This is not the 17-company Merit seed, so most pages render **real but thin or empty** data.
- **States walked:** "All companies", then **Coho** (every Books page), then **Northwind** (Invoices, Collections, Bills,
  Cash, Practice and Platform). Acme was seen only on the Dashboard, Close and Entities roll-ups.
- **Coverage:**
  - All 64 sidebar destinations across Books, Practice and Platform.
  - The §7 key pages, including the sub-surfaces listed there: bank-feed tabs, explainer and edit panel; recon
    Autopilot and Statement tab; Close Tasks, Status and Year-End; the JE drawer and peek; Approvals Simulate; the
    entity snapshot.
  - **Not visited:** off-nav routes (`/retainage`, `/fixed-assets`, `/leases`, the `/tax-*` sub-pages,
    `/settings/new-entity`, `/inventory/[id]`, `/jobs/[id]`).
- **Evidence:** a 0.5-scale screenshot was taken of every page in the table below (shown in-session, not saved to the
  repo). Console errors were read with an errors-only filter, and network calls to `/api/*` were checked for 4xx/5xx.
- **Speed:** in-app navigation through the sidebar renders in **1–3 s**. A **hard load** (typing a URL, refresh or a
  deep link) is much slower. **8–15 s** was typical, `/close` never finished (spinner for more than 35 s), and some
  hard loads stayed stuck until the first click. See L.3 bug **L1**.
  - Caveat: the automated Chrome window may not have had focus, which can make React's idle hydration slower. The React
    hydration errors in L1 are real regardless of that.

### L.1 Per-page live status

Legend: Y = renders, E = renders an empty state. "Net" lists only non-2xx `/api/*` calls; otherwise every call was
200. Screenshot = y for every row.

**Books — Home and Payables**

| Route | Renders | Data | Issues seen live | Console / Net |
|---|---|---|---|---|
| `/dashboard` (All, Coho, NWC) | Y | Real (3 cos) | **Same board whatever company is selected**, and the selected card isn't highlighted. Consolidated "Approvals 0" vs card "Proposals 50 / 48". Activity feed repeats identical rows (e.g. `INTRST PYMNT $4.22` ×3). "Cash $213.5K" is the bank-feed balance, not GL cash (L6). | — |
| `/inbox` | Y | Real | Badge says "99+ need you" but it **opens on the empty Approvals tab**; the work is under Exceptions. Rows show raw filenames, UUIDs and codes (`DEBT_EXTRACT`, `COVENANT_DRIFT`), and one loan extraction appears 4×. Clicking a row goes to the generic `/ai-decisions` list, not the item. `j` moves focus, but the focus ring is faint. | — |
| `/bills` | E (all 3 cos) | Empty | Tabs: All Bills / Intake / Retainage / AP Policy. Hard load about 5 s. | — |
| `/expenses`, `/receipts`, `/purchase-orders` | E | Empty | Good empty states. Receipts are separate from Expenses, even though Expenses are "built from receipts". | — |
| `/checks` | E | Empty | Sidebar says "**Pay Runs**", page says "**Check Run**". Hard load more than 8 s. | — |
| `/payroll` | E | Empty | Hard load about 10 s. | **`GET /api/integrations/connections` 500** (L2) |
| `/vendors` | Y | 2 vendors | **Not company-scoped**: no `location_id` is sent. Builds its own `<h1>` (no "Working in" chip) and uses a different page padding. | — |
| `/vendor-compliance` | Y | "0/0" | Says "No vendors tracking compliance documents", while `/vendors` shows red ✕ W9/GL/WC badges on both vendors. | — |

**Books — Receivables**

| Route | Renders | Data | Issues seen live | Console / Net |
|---|---|---|---|---|
| `/invoices` | Y | Coho empty; NWC 2 | In-page "**All Companies**" picker contradicts the header. A $150K invoice **97 days late** has status *Sent*: Overdue tile $0.00 and Overdue tab 0 (L4). Tabs sit **above** the title. Peek opens pinned bottom-left (L11). Drawer title truncates to "Invoice I…". Hard load about 10 s. | — |
| `/estimates` | E | Empty | Hard load about 15 s. | — |
| `/collections` | Y | NWC $150K in 90+ | **As-of date defaults to tomorrow** (10/20 at 8:45 PM CT on 10/19; UTC date, L14). In-page "All companies" picker. Good aging strip and worklist. | — |
| `/customers` | Y | 3 | Not company-scoped. Builds its own `<h1>`. | — |
| `/customer-deposits` | E | Empty | Subledger ⇄ GL 2420 tie-out reads "In balance". Good. | — |
| `/rev-rec` | Y | 1 job (POS) | Clean. | — |

**Books — Banking & Cash**

| Route | Renders | Data | Issues seen live | Console / Net |
|---|---|---|---|---|
| `/bank-feed` (3 tabs, explainer, edit panel) | Y | Coho 46 txns / $33.5K | Explainer and edit panel are excellent; the panel deep-links with `?id=`; `j`/`k` work. Company column truncates "[SANDBOX] …" and is redundant once one company is selected. Status tabs read "Pending 0 · Categorized 46", yet all 46 still need review. The **Credit Cards tab repeats rows already shown on the Bank Feed tab** (Tectra $500, AUTOMATIC PAYMENT $2,078.50). Apply Deposits prints its subtitle twice. | **`GET /api/integrations/plaid/sync` 500** (L2) |
| `/reconciliation` | Y | 12 Plaid accts | **Autopilot is the best screen in the app** (May checking: Auto 2 / Review 1 / Escalate 1, confidence bars, GL vs statement vs difference strip). Statement tab has an in-page "All Companies" picker. The workspace opens as a modal that needs **Start** (a write), so the decomposer can't be reached read-only. **Tabs are not in the URL** (confirmed). | — |
| `/cash` | Y | Coho | Cash "as of 6/9/2026"; "12 accounts have no recent feed activity". Balance Trend shows $208.1K **and** "No feed history to chart yet". | **`plaid/sync` 500, `plaid/map` 500** (L2) |
| `/debt` | Y | 2 loans | The loans carry real portfolio names (Clive Power Equipment note, Farmers State Bank) inside a [SANDBOX] company (L17). Raw technical footnote. | — |
| `/borrowing-base` | E | — | Breadcrumb says "← Reports", but the page sits under Banking in the nav. | — |
| `/obligations` | Y | 2 items | **N1 confirmed live**: "Some sources were unavailable and skipped: subscriptions." The revolver shows "398d overdue". | — |
| `/subscriptions` | E | — | Clean. | — |

**Books — Accounting, Jobs & Costing**

| Route | Renders | Data | Issues seen live | Console / Net |
|---|---|---|---|---|
| `/journal-entries` | Y | 7 JEs | Drawer is excellent: Dr/Cr lines, "Balanced", Explain. Hover peek works but **renders bottom-left over the sidebar** (L11). `?highlight=` and `?entry=` are ignored (bug 5). An **Edit** button shows on POSTED entries. | — |
| `/chart-of-accounts` | Y | 151 accts | Balance-sheet accounts show period and YTD **activity**, not balances: Liabilities shows "—" although $1.46M of loans were posted in 2024. | — |
| `/assets`, `/tax` | Y | Card hubs | `/tax` hard load sat in the pre-hydration shell for about 13 s (L1). | — |
| `/internal-invoices` | E | — | Clean. | — |
| `/departments` | Y | 5 depts | Lists all 3 companies' departments with one company selected. | — |
| `/documents` | Y | 1 doc (unlinked) | Description runs to about 60 words. | — |
| `/periods` | Y | 3 × 12 grid | Good. | — |
| `/close` (Tasks / Status / Year-End) | Hard load: **never** (>35 s); sidebar: Y in about 3 s | Real | Tasks are excellent (live-verified checks, blocker chips, deep links). Counts contradict each other: "Uncategorized activity cleared · 46 item(s), none material" vs "$33,465.37 uncoded" vs Status "Not in GL $33.5K". Status shows "Bank rec: Not started" while Autopilot shows 2/4 cleared. Year-End prints its subtitle twice. | **RSC prefetch `/close?_rsc` 503** (L3) |
| `/jobs` | Y | 1 job | Scoped correctly. | — |
| `/jobs/wip` | Y | 5 jobs | **Not scoped**: shows NWC and DEMO jobs while Coho is selected. "100%" margin on jobs with $0 cost. | — |
| `/inventory` | E | — | Header chip is squeezed beside the title. | — |

**Books — Reporting & Analytics**

| Route | Renders | Data | Issues seen live | Console / Net |
|---|---|---|---|---|
| `/reports` (All + Coho) | Y | Real | Renders fine in **All** (the sidebar hides it in All). Defaults to "This Month", which is empty. **% column shows 120000% and 5000000%** when revenue is 0 (L8). GL drill-down works; its modal **ignores Esc** (L12). "Ask for any report…" does nothing (bug 8). The URL never reflects the open report. Viewing a report POSTs `/api/learning/preferences` (L19). | — |
| `/reports/basis-adjustments` | E | — | API call carries no `location_id`. Description runs to about 90 words. | — |
| `/fpna` | Y | Coho | Cash **$1.4M** and AR **$50K**; the Dashboard shows Coho AR $0 (L6). | — |
| `/budgets` | Y | Grid | Two stacked tab rows (Plan / Driver Builder / Reforecast over Budget Entry / BvA / Scenarios). | — |
| `/profitability` | E (Oct) | — | Clean. | — |
| `/consolidation` | Y | Coho | **Balance check −$50,000** in red. Total eliminations −$50,000 on a one-entity group (L5). | — |
| `/board-package` | Y | Coho Sep | Balance sheet "**Off by $488.00**" with equity $0. Cash $0, yet the trend shows $1.4M. Total debt **$1.46M** (original principal) vs Debt page **$897.8K** outstanding (L7). Fetched 3× (L20). | — |
| `/search` | Y | 9 hits for "United" | Titles read "**JEJE**-2026-000032" (L13). Results don't refresh after a company switch. | — |
| `/ai-decisions` | Y | ~100 rows | Narrower centred layout. Raw codes. | — |
| `/categorize` | Y | Form | In-page company "Select…" ignores the header picker. | — |
| `/agents` | Y | — | Asks the user to paste a "`bill_id (uuid of a PENDING / ON_HOLD bill)`". | — |

**Practice**

| Route | Renders | Data | Issues seen live | Console / Net |
|---|---|---|---|---|
| `/portfolio` (Entities) | Y | 3 cos | Good red/amber/green board, but it overlaps the Dashboard almost completely. | — |
| `/portfolio/[id]` | Y | Coho | "Out of balance by $488.00". GL cash $1.41M vs bank cash $213.5K. Links pass `?location_id=`, which is ignored (bug 11). | — |
| `/team` | Y | 3 members | Clean. | — |
| `/compliance` | E | — | Filings / Controls tabs. | — |
| `/audit` | Y | 4 events | Human-vs-AI attribution is good. "AI pending 103". | — |
| `/pbc` | E | — | Clean. | — |
| `/onboarding` | Y (after hydration) | 3 cos | Renders in the **Book of Record** plane, though its nav entry is in Practice. | — |
| `/onboarding/portfolio` | Y | 3 cos | Sidebar highlights **Get Started and Many Companies at once** (L15). | **React #425, #418, #423 (hydration failure)** (L1) |
| `/settings/billing`, `/settings/approvals` (+Simulate), `/settings/autonomy`, `/integrations/erp`, `/onboarding/conversion` | Y | Real | Simulate works read-only and is good. `/onboarding/conversion` also double-highlights in the sidebar. | — |
| `/settings/payments` | Y | — | "Connected — payments are live and payouts are enabled" in a sandbox org on a dev auth instance (L21). | — |
| `/settings/roles` | Y | 10 roles | A system role is named "**Merit Controller**", a tenant name hard-coded into a white-label product (L17). | — |
| `/import` | Y | — | Shows raw table names (`core.locations`, `public.gl_entries`). | — |
| `/operations` | Y | — | "**All books are current — nothing needs your attention**" while 98 exceptions are open (L9). | — |
| `/settings` | Y | Org | 10 in-page sub-tabs, on top of 6 separate settings pages in the sidebar. | — |

**Platform**

| Route | Renders | Data | Issues seen live | Console / Net |
|---|---|---|---|---|
| `/platform` | Y | 2 tenants | Both tenants are named "Merit Management Group". "Ops health: No open errors" while L1/L2 errors were firing (L18). The cross-tenant fee call carries a tenant `location_id`. | — |

**Broken pages:** none are hard-broken through in-app navigation.
- `/close` never completes on a hard load (a 503 was seen).
- Bank Feed, Cash and Payroll each make 1–2 failing status calls (500) on every load.
- Hard-loaded pages hit a hydration failure (L1).

### L.2 Code-audit bug verification

| # | Claimed bug | Live result |
|---|---|---|
| 1 | Bank-feed edit panel drops vendor-name edits | **Not testable read-only.** The "Vendor name…" field is present, empty for an unidentified vendor, and editable. Proving the drop needs a Save & Approve, which writes. |
| 2 | Credit Cards Flag is dead | **Not tested.** If the button works, clicking it writes. The flag icon is on every card row. Card rows have no edit pencil (only approve and flag). |
| 3 | ⌘K opens two overlays | **CONFIRMED.** The `Search` and `Natural language command` dialogs are both in the DOM. Esc closes the command bar and reveals the search palette underneath. |
| 4 | "CPA Desk ⌘K" button is dead | **CONFIRMED.** Clicking it opens nothing (no dialog). |
| 5 | "View GL" links ignored | **CONFIRMED.** `/journal-entries?highlight=<id>` and `?entry=<id>` both load the plain list. `?id=<id>` opens the drawer. |
| 6 | CoA Approve/Reject failures are silent | Not testable read-only. |
| 7 | Bills/Receipts capped at 50 rows | **Not reproducible.** There are 0 bills and 0 receipts in all 3 companies. |
| 8 | Reports "Ask for any report…" does nothing | **CONFIRMED.** Typing "balance sheet" + Enter filtered nothing and sent no request. |
| 9 | Board Package "Operating Income" bound to EBITDA | **Not distinguishable**: every P&L line is $0 for Sep. The package has bigger defects (L5, L7). |
| 10 | Platform "Companies" column sorts by MRR | **Not distinguishable.** Both tenants rank the same by companies and by MRR (3 / $297 and 1 / $99). |
| 11 | Portfolio and snapshot links don't switch company | **CONFIRMED.** `/cash?location_id=<Coho>` with Northwind active showed Northwind's $0 and called `/api/cash?location_id=<Northwind>`. |
| §1.2 | The sidebar hides every group but Home in "All" | **CONFIRMED.** Meanwhile `/reports` renders correctly in All. |
| §5 | Tabs not in the URL | **CONFIRMED** on Reconciliation. Inbox, Close and Bank Feed *do* use `?tab=`. |
| §5 | In-page company pickers | **CONFIRMED** on Invoices, Collections, Recon Statement tab and AI Categorizer. |
| §5 | Pages with their own `<h1>` lose the chip | **CONFIRMED** on Vendors, Customers and Estimates (no "Working in" chip). Invoices has a non-standard header. |
| N1 | Obligations "subscriptions" source fails | **CONFIRMED live**: the banner on `/obligations`. |

### L.3 New bugs found live (report only, not fixed)

**Carried over from the first (signed-out) attempt, now confirmed live:**

- **N1 · The obligations "subscriptions" source fails on every load.**
  - **Evidence:** the Vercel log `[obligations] source 'subscriptions' degraded: column subscriptions.name does not
    exist` (281 hits in 7 days, route `/api/inbox`), plus the live `/obligations` banner.
  - **Cause:** `lib/obligations/collect.ts:467` selects `name`, but migration `085_subscriptions.sql` has only
    `vendor_name` and `product`.
  - **Fix (not applied):** select `product` and label the row with `vendor_name`.
  - **Guard test to add:** check that every column named in a `.select('…')` literal exists in the migrations.

**Platform and performance**

- **L1 · Hydration failure on hard loads (high).**
  - **Error:** React **#425** (text mismatch), **#418** (hydration mismatch) and **#423** (root falls back to client
    rendering), logged once the stalled `/onboarding` hard load hydrated.
  - **Symptom:** after a refresh or deep link the shell sits for 8–35 s+ in its pre-hydration state. The header shows
    "**All Companies**" whatever the cookie says, the sidebar shows Home only, the avatar and badge are missing, and the
    body is a spinner. In-app navigation is fine. A user who refreshes sees the wrong company for several seconds.
  - **Likely cause:** server-UTC vs browser-local values in rendered output, e.g. `new Date().toISOString().slice(0,10)`
    in `collections/collections-workflow.tsx:116` and `invoices/collections/collections-dashboard.tsx:93`, or
    cookie-derived shell state.
- **L2 · Integration status endpoints 500 on every load (high).**
  - **Endpoints:** `GET /api/integrations/plaid/sync`, `/plaid/map` and `/connections`.
  - **Error:** `{"error":"No organization claim on request; cannot resolve tenant"}`.
  - **Cause:** the Clerk session has no `org_id` claim, and these routes resolve the tenant from the claim only. Other
    routes use the membership resolver. This is part of identity gate #9.
  - **Callers:** Bank Feed, Cash and Payroll, so Plaid connection status never loads.
- **L3 · The sidebar prefetches every link.** One click fires about 40–60 `?_rsc=` requests for `force-dynamic` pages,
  and one `/close?_rsc` returned **503**. This is server load and likely part of the slowness. Fix: `prefetch={false}`
  on the nav links.
- **L18 · Ops health misses errors.** The Platform console reports "No open errors" while L1 and L2 were firing.
- **L19 · A report view causes a write.** Opening a report POSTs `/api/learning/preferences`.
- **L20 · Duplicate fetches.** JE, invoice and bank-feed-insight drawers each fetch twice (with and without
  `location_id`). The board package fetches three times.
- **L21 · Payments setting.** `/settings/payments` says "payments are live" in a sandbox org. Confirm whether Stripe is
  in live mode.

**Accounting correctness**

- **L4 · Overdue is not derived.** An invoice 97 days past due stays *Sent*. Invoices shows Overdue $0 / 0, while
  Collections shows $150K overdue in the 90+ bucket.
- **L5 · Balance sheets don't balance.**
  - The board package says "Off by $488.00" and the entity snapshot says "Out of balance by $488.00". Current-year net
    income is not rolled into equity, which shows $0.
  - Consolidation's balance check is **−$50,000**, from a one-sided intercompany elimination on a one-entity group.
- **L6 · Five different "cash" numbers for one company.** Dashboard/Entities $213.5K (bank balances), FP&A $1.4M,
  snapshot GL $1.41M, CoA Assets YTD $488, board-package cash $0 (but its trend shows $1.4M).
- **L7 · Board package debt is wrong.** It uses original principal: $1.46M vs $897.8K outstanding on `/debt`. The
  matured revolver shows $400K there but $0.00 on `/debt`.
- **L8 · P&L % of revenue breaks when revenue is 0.** It shows 120000% and 5000000%; it should show "—".

**Workflow and data consistency**

- **L9 · Attention counts disagree.** Dashboard Approvals 0 / Proposals 98; Inbox 99+ but lands on an empty tab; Close
  98 exceptions; Operations "nothing needs your attention"; Audit "AI pending 103".
- **L10 · Scope leaks with one company selected.** Vendors, Customers, Departments, Job WIP, Basis Adjustments and
  Search show every company, or call the API without `location_id`. The Jobs list *is* scoped.
- **L14 · Dates in UTC.** Collections as-of and days-late, and the board package's "evaluated through October 20", run
  a day ahead for US evenings.
- **L17 · White-label leaks.**
  - The system role is called "Merit Controller".
  - Two tenants are both called "Merit Management Group", and the slug is `revived-interiors`.
  - Real portfolio names (Clive Power Equipment, MERIT SPE 2 LLC, Farmers State Bank) appear inside [SANDBOX]
    companies' loans and exceptions. This is test-data hygiene, and worth checking for cross-tenant seeding.
- **Smaller items.**
  - The Credit Cards tab duplicates Bank Feed rows.
  - Vendor Compliance reports 0/0 while Vendors shows failing badges.
  - WIP shows 100% margin on $0-cost jobs.
  - The Inbox shows duplicate loan-extraction items.
  - Apply Deposits and Year-End print their subtitles twice.
  - "Pay Runs" in the nav vs "Check Run" on the page.
  - The Borrowing Base breadcrumb points to Reports.

**Navigation and interaction**

- **L11 · Hover peeks are mispositioned.** JE and invoice peeks render pinned bottom-left over the sidebar, not beside
  the row.
- **L12 · The report GL-detail modal ignores Esc.** Clicks behind it are swallowed; only the ✕ closes it.
- **L13 · Search.** Titles read "JEJE-…" (doubled prefix), and results don't re-run after a company switch.
- **L15 · Nav highlighting uses prefix matching.** "Get Started" stays lit on `/onboarding/portfolio` and
  `/onboarding/conversion`.
- **L16 · The plane switcher doesn't navigate.**
  - Switching to Practice on `/bills` leaves the Bills page up with no picker.
  - Hard-loaded Practice pages render in the Book of Record plane.
  - `/onboarding` renders in Book of Record, though its nav entry is in Practice.

### L.4 Visual design today, and what feels genuinely good

**Visual design**

- The base is a near-black, green-tinted dark theme with an emerald accent, and indigo reserved for AI actions.
  - Plus Jakarta Sans for UI and JetBrains Mono for every number and code.
  - Pill tabs, 1-px bordered cards, and good empty states (icon + sentence + one CTA).
- Almost every page opens with a 4–8 tile KPI strip of equal weight, so nothing reads as primary.
- Type is small: labels about 10 px uppercase in slate-500 on near-black, which is a **contrast risk**. The tables are
  dense and readable.
- Three different page widths are in use:
  - full-bleed: most pages;
  - centred max-width: Vendors, Customers, Estimates, AI Decision Log, Assets, Tax, Agents, Onboarding;
  - squeezed header: Inventory.
- There is no chart vocabulary beyond a few hand-drawn trends.

**Keep — confirmed good live**

- Bank feed:
  - the "Why this confidence" modal (AI confidence + auto-approve checklist + reasoning);
  - the deep-linked edit slide-out;
  - `j`/`k` row movement;
  - the confidence-bucket quick-select chips.
- Reconciliation Autopilot: Auto / Review / Escalate chips, per-line pattern and confidence bar, and the
  GL-vs-statement-vs-difference strip.
- The JE drawer: Dr/Cr table, "Balanced", Explain, and the `?id=` deep link.
- Report → GL-detail drill-down (fix only the Esc behaviour).
- Close Tasks: auto-verified checks with amounts and blocker chips. Also the Close **Status** board.
- The Entities board (red/amber/green roll-up with blockers per company). It is the best "portfolio" view and should
  *become* the Dashboard.
- Collections: aging strip + worklist. Customer Deposits: subledger ⇄ GL tie-out badge.
- The fiscal-period grid. The Many Companies control tower. Approvals **Simulate**. The autonomy kill switch.
- The Audit Trail's human-vs-AI attribution.
- Client-side navigation speed (1–3 s).

### L.5 How the work naturally groups (organization evidence)

These are observations from walking the app as an operator. The owner wants a from-scratch structure, so the point is
where today's tabs **split one job across places** or **join unrelated jobs**.

1. **"What needs me" is spread across six surfaces.** Dashboard counts, Inbox (4 tabs), Close Tasks blockers,
   Operations "needs your attention", the AI Decision Log, and Entities exceptions. They disagree (L9). Users think
   *"my queue"*, not *"which module raised it"*. **There should be one Work queue**, filterable by company and type,
   with every item deep-linking to its record.
2. **Customer money is split across three nav groups.** Invoices, Estimates, Collections (which is also a button on
   Invoices), Customers, Deposits and Rev-rec sit in Receivables. **Apply Deposits** lives in *Bank Feed*. **AR ⇄ GL
   tie-out** lives in *Reconciliation*. A user collecting cash moves invoice → payment → application → tie-out, and that
   path should live in one place.
3. **Vendor money is split the same way.** Bills (with Intake / Retainage / AP Policy tabs), Expenses, **Receipts
   (separate, though expenses are built from receipts)**, POs, Pay Runs, Payroll, Vendors and Vendor Compliance (with a
   1099 tab). Credit-card charges sit in *Bank Feed*. The natural flow is: request/PO → bill or receipt → approve → pay.
   1099 and compliance are vendor attributes, not pages.
4. **"Banking" really holds two jobs.** One is *clearing transactions* (bank feed, cards, reconciliation). The other is
   *knowing cash and commitments* (cash position, 13-week forecast, debt, borrowing base, obligations, subscriptions).
   Debt payments already appear inside Obligations; subscriptions are obligations; the Borrowing Base breadcrumb says
   Reports. **Merge them into "Cash & commitments"**, separate from transaction clearing.
5. **The ledger and close are one workspace.** JEs, CoA, Periods, Close (with Year-End), Assets & Schedules, Internal
   Invoices, Departments, Tax, Documents, and **Basis Adjustments (filed under Reporting, but it is a ledger
   presentation layer)**. The Close checklist already deep-links into most of these; it is the natural hub.
6. **"AI" is not a destination.** The AI Categorizer, AI Decision Log, Agents and Search are filed under "Reporting &
   Analytics". The live app shows AI is best *embedded*: explainer, Autopilot, Explain buttons. Users need one AI
   *log/controls* page (with Audit and Autonomy), not four AI pages.
7. **Insight pages overlap.** Dashboard ≈ Entities. FP&A ≈ Profitability ≈ entity snapshot. Reports, Consolidation and
   Board Package all compute statements, with different numbers (L5–L7). A user wants one statements engine, viewed as
   report / pack / board deck.
8. **Setup is scattered.** Get Started, Many Companies, Historical Conversion, Import Data and Integrations are all
   "getting data in". Settings is split into 10 in-page tabs *plus* 6 sidebar entries. Entities (an owner/CFO view)
   sits under "Team & Oversight" next to admin.
9. **Company scope must be one honest control.** Half the pages ignore the header picker: in-page pickers, unscoped
   lists (L10), ignored `?location_id=` links. Planes don't navigate (L16). The redesign should make "which company"
   a single control, label portfolio-level pages explicitly as All-companies views, and never hide them when "All" is
   selected.

**A grouping the evidence supports (input to IA-SPEC, not a decision):**

| Group | Contents |
|---|---|
| **Home** | Work queue + portfolio overview (Entities board) |
| **Money in** | Quotes → invoices → collections → payments/application → deposits, rev-rec, customers |
| **Money out** | POs → bills/receipts/expenses/cards → approvals → pay runs, payroll, vendors (compliance and 1099 inside the vendor record) |
| **Banking** | Feed + cards clearing, reconciliation (with tie-outs) |
| **Cash & commitments** | Position, forecast, debt, borrowing base, obligations, subscriptions |
| **Books** | Journal, accounts, schedules, internal invoices, dimensions, close + periods + year-end, tax, documents |
| **Insights** | One statements engine: reports / FP&A / budgets / consolidation / board pack |
| **Controls** | Audit trail, AI log + autonomy, approvals, compliance, PBC |
| **Setup** | Companies, team & roles, data in (import / conversion / integrations), billing, settings |
| **Platform** | Kept separate |

### L.6 Refined recommendations (updates §6)

1. **Fix before the redesign** (most are small):
   - L2: use the membership resolver on the three integrations routes.
   - L1: remove UTC/local and cookie-driven text from server-rendered output; render dates client-side or from a fixed
     org timezone.
   - L3: turn off nav-link prefetch.
   - L4: derive overdue from the due date.
   - L5: roll current-year earnings into equity in the balance-sheet builders, and fix the single-entity elimination.
   - L7: use outstanding balance in the board-package debt figure.
   - L8: show "—" for % of revenue when revenue is 0.
   - Confirmed code bugs 3, 4, 5, 8 and 11; N1.
2. **Pick one source per figure** (cash, AR, debt, exception count) and use it on every surface. Today every surface
   computes its own.
3. **Keep/merge changes from the live pass:**
   - Make the Entities board the Dashboard. Retire the duplicate company cards.
   - Fold Operations' "needs attention" and the AI Decision Log into the Work queue.
   - Move Apply Deposits next to invoices and payments. Put AR tie-out with reconciliation and close.
   - Put Credit Cards inside the feed as a filter, not a tab with the same rows.
   - Merge Receipts into Expenses.
   - Move Basis Adjustments into Books.
   - Retire the in-page company pickers.
4. **Keep everything in L.4 "Keep"**, and port the bank-feed explainer, Recon Autopilot, JE drawer and Close Tasks
   patterns into the shared component kit (`components.html`) as reference implementations.
5. **Re-run** the Bills/Receipts 50-row cap and the Board "Operating Income" label checks once a company has more than
   50 bills and non-zero P&L (e.g. the 17-company Merit seed). Re-run L1 in a normal, focused browser to measure real
   hard-load time.
