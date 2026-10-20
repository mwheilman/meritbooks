# Industry modules: what the lead registers

The industry-module UI lives in files this wave owns: `app/(app)/{dispatch,work-orders,agreements,assets,production,selections,draws,units,time,daily-logs,punch-list}`, `app/api/ops/**`, `components/ops/**` and `lib/pm/ops/**`. The pages work today at their URLs. Three shared files decide whether people can find them: `lib/pm/guards.ts`, `lib/pm/job-tabs.ts` with the job page, and `lib/nav.ts`. The home components decide the widgets. This wave did not edit any of those files. The edits below are all the lead has to make.

## 1. Job tabs

### 1a. `lib/pm/guards.ts`: widen `JobTab`

Add the five new values. `selections`, `logs` and `time` already exist.

```ts
export type JobTab =
  | 'overview' | 'estimates' | 'budget' | 'schedule' | 'change-orders' | 'contract' | 'activity'
  | 'commitments' | 'billing' | 'job-cost' | 'selections' | 'logs' | 'time' | 'documents'
  | 'work-orders' | 'production' | 'draws' | 'units' | 'punch';
```

The `selections_approved` guard can now send people to the job tab, not the company-wide list:

```ts
fix: { label: 'Open selections', tab: 'selections' },
```

### 1b. `lib/pm/job-tabs.ts`: the tab list

Add `import { woVocab } from '@/lib/pm/ops/labels';`. It is pure, with no server-only import. Replace the three `later: true` lines for selections, logs and time with the block below, and keep `documents` as it is. Order follows the job's life: field work, then shop, then client decisions, then lender and lots, then the site record.

| Tab value | Label | Shows when the job type has | Component import |
|---|---|---|---|
| `work-orders` | `woVocab(v).many`, which reads "Visits", "Install tickets", "Repair orders" or "Work orders" | `dispatch` | `import { WorkOrdersTab } from '@/components/ops/job-tabs/WorkOrdersTab'` |
| `production` | `'Production'` | `production` | `import { ProductionTab } from '@/components/ops/job-tabs/ProductionTab'` |
| `selections` | `v.selections` | `selections` or `procurement_markup` | `import { SelectionsTab } from '@/components/ops/job-tabs/SelectionsTab'` |
| `draws` | `v.draws` | `lender_draws` | `import { DrawsTab } from '@/components/ops/job-tabs/DrawsTab'` |
| `units` | `'Lots and units'` | `lots_units` | `import { UnitsTab } from '@/components/ops/job-tabs/UnitsTab'` |
| `logs` | `v.daily_logs` | `daily_logs` | `import { LogsTab } from '@/components/ops/job-tabs/LogsTab'` |
| `punch` | `'Punch list'` | `punch_warranty` | `import { PunchTab } from '@/components/ops/job-tabs/PunchTab'` |
| `time` | `'Time'` | `time` | `import { TimeTab } from '@/components/ops/job-tabs/TimeTab'` |

```ts
if (modules.has('dispatch')) t.push({ value: 'work-orders', label: woVocab(v).many });
if (modules.has('production')) t.push({ value: 'production', label: 'Production' });
if (modules.has('selections') || modules.has('procurement_markup')) t.push({ value: 'selections', label: v.selections });
if (modules.has('lender_draws')) t.push({ value: 'draws', label: v.draws });
if (modules.has('lots_units')) t.push({ value: 'units', label: 'Lots and units' });
if (modules.has('daily_logs')) t.push({ value: 'logs', label: v.daily_logs });
if (modules.has('punch_warranty')) t.push({ value: 'punch', label: 'Punch list' });
if (modules.has('time')) t.push({ value: 'time', label: 'Time' });
if (modules.has('documents')) t.push({ value: 'documents', label: 'Documents', later: true });
```

### 1c. Job page `app/(app)/jobs/[jobId]/page.tsx`: the bodies

Every panel is an async server component with the same props. Each one loads its own data on the RLS client, imports `components/ops/ops.css` and handles its own loading, empty and error states. The job page already has `modules`, which is the job type's `ReadonlySet<ModuleKey>`, and `vocab`. The panels also accept an array.

```tsx
const opsProps = { jobId: list.job_id, companyId: list.location_id, modules, vocabulary: vocab };
// …
} else if (tab.value === 'work-orders') {
  body = <WorkOrdersTab {...opsProps} />;
} else if (tab.value === 'production') {
  body = <ProductionTab {...opsProps} />;
} else if (tab.value === 'selections') {
  body = <SelectionsTab {...opsProps} />;
} else if (tab.value === 'draws') {
  body = <DrawsTab {...opsProps} />;
} else if (tab.value === 'units') {
  body = <UnitsTab {...opsProps} />;
} else if (tab.value === 'logs') {
  body = <LogsTab {...opsProps} />;
} else if (tab.value === 'punch') {
  body = <PunchTab {...opsProps} />;
} else if (tab.value === 'time') {
  body = <TimeTab {...opsProps} />;
}
```

After this, the `selections`, `logs` and `time` entries in `LATER_WHAT` are no longer used and can go. The ops pages already link to `/jobs/<id>?tab=logs`. The release-to-shop gate links to `?tab=budget`, which exists today.

## 2. Rail (`lib/nav.ts`)

Dispatch, work orders, daily logs, time, production, selections and draws are already in the rail. The changes:

1. **Work orders label.** In the Field group, change `a(v.work_orders, '/work-orders', 'dispatch')` to `a(woVocab(v).many, '/work-orders', 'dispatch')`. Today a dealer company sees "RO lines", but the page lists repair orders. The page's own `<title>` and heading already use `woVocab`.
2. **Four missing entries**, all `disclosure: 'A'` through the existing `a()` helper:

| Group | Entry | Code |
|---|---|---|
| Field, after work orders | Agreements | `a('Agreements', '/agreements', 'service_agreements')` |
| Field, after Agreements | Equipment | `a('Equipment', '/assets', 'assets')` |
| Field, after Daily logs | Punch list | `a('Punch list', '/punch-list', 'punch_warranty')` |
| Jobs, after selections | Lots and units | `a('Lots and units', '/units', 'lots_units')` |

None of the new pages registers a `g x` chord. The chords taken today are g h, g r, g j, g c, g s, g p and g a, so `g d` for Dispatch is free if you want one.

## 3. `lib/areas.ts`

Static routes now cover these slugs, and a static segment wins over `[area]`: `selections`, `dispatch`, `work-orders`, `daily-logs`, `punch-list`, `time`, `production`, `draws`. Their "Arrives in the next release" entries can be removed. Keep `inbox`, `leads`, `wip`, `ai-decisions` and `compare`.

## 4. Home widgets (`components/ops/widgets`)

These are client widgets in the same mould as `SeamHealthWidget`. Each one fetches `GET /api/ops/widgets/<key>` (RLS, scoped to the companies in the current view) and renders a merit-ui `<Widget>` with loading, empty or done, and error-with-retry states. Each takes `{ x?, y?, w?, h?, companyId?, limit? }`. Import them from `@/components/ops/widgets`.

| Widget | Key | Reads | Show it when the company has | Default size |
|---|---|---|---|---|
| `SignalsWidget` | `signals` | `pm.kpi_defs` and `pm.v_kpis`. Each pack measure has a comparison and a destination, in a ranked list, not a strip of cards | any of `dispatch`, `service_agreements`, `production`, `selections`, `procurement_markup`, `lender_draws`. The widget explains itself when the pack names only margin or billing measures | 4×4 |
| `TodaysVisitsWidget` | `visits` | today's `dispatch_assignments` and `v_dispatch_queue` | `dispatch` | 4×2 |
| `ShopLoadWidget` | `shop` | `v_work_center_load` and `v_production_status` | `production` | 4×2 |
| `SelectionsDueWidget` | `selections` | `v_selection_status`, open, proposed or declined, due within 14 days or past due | `selections` | 4×2 |
| `DrawsInFlightWidget` | `draws` | `v_draw_summary`, draft, submitted, inspected, approved or returned | `lender_draws` | 4×2 |

Placement in `PmHome` (cockpit): add them after `SeamHealthWidget`, gated by the company's modules. That means passing `modules` into `PmHome`, since `HomeData` does not carry them today. Leave out `x`/`y` so `Dash flow="row"` packs them and a widget that is gated off leaves no hole. Example:

```tsx
{has('dispatch') && <TodaysVisitsWidget />}
{has('production') && <ShopLoadWidget />}
{has('selections') && <SelectionsDueWidget />}
{has('lender_draws') && <DrawsInFlightWidget />}
{opsModulesOn && <SignalsWidget />}
```

`SignalsWidget` also suits `OwnerHome` (report density). In a workspace or consolidated view it compares companies, so pass nothing there. Pass `companyId` only to pin a widget to one company.
