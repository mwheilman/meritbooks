# Report engine API (Wave 3A)

The one engine every statement, metric, chart and pack reads. Spec + acceptance criteria:
`docs/FPB-financial-reports.md` §4 (Amendment A-3A). Code: `apps/web/src/lib/reports/engine/`.
Migration: `packages/supabase/migrations/185_report_engine_period_balances.sql`.

## 1. Layers

| Layer | File | Runs | What it does |
|---|---|---|---|
| Store | mig 185 `public.period_balances` | Postgres | Accrual balances by org × company × account × month × department / class / job / item / counterparty × entry kind. Maintained **in the posting transaction** by triggers. |
| Read RPCs | mig 185 `report_balances`, `report_drill_lines`, `period_balances_tieout` | Postgres, SECURITY INVOKER (RLS + client scope) | One jsonb round-trip each (never PostgREST-row-capped). |
| Contract | `types.ts` | anywhere | Request / result / drill types. **Publish-stable.** |
| Pure core | `periods.ts`, `layout.ts`, `aggregate.ts`, `plan.ts`, `build.ts`, `format.ts`, `to-model.ts` | anywhere (no I/O, no clock) | plan → build → result. |
| Adapter | `adapter.ts` | server only | Loads reference data + balances through the caller's RLS client, validates client scope, runs the core, applies governance. |
| Governance hook | `governance-hook.ts` | server | `applyGovernance(view, ctx)` — 3D registers its implementation. |
| HTTP | `app/api/reports/engine/{run,drill,tie-out,meta,prefs,layouts}` | server | Thin routes (auth → permission → zod → adapter). |

## 2. Conventions (binding)

- Money = integer **cents**. Internally every account amount is **debit-positive** (debit − credit);
  `ReportRow.values` are in **presentation** space (revenue +, expense +, liabilities +, equity +).
  `ReportRow.drillSign` converts: `value = drillSign × Σ(debit − credit)` of the drilled lines.
- Percent values are numbers in **percent units** (12.5 = 12.5 %), 1 decimal, `null` when
  undefined. Margin variances are in **points** (`formatPoints`).
- Rounding is **presentation only**: `formatAmount(cents, rounding)` rounds each figure from exact
  cents; totals are computed before rounding (no drift). Exports carry exact cents.
- Accounts are resolved by **type / sub-type / group / role / bank flag**, never by number
  (number ranges only as an explicit custom-layout choice). No `EXPENSE` type.
- Company = `gl_entry_lines.location_id` (the leg's own company). Months are calendar months;
  fiscal years are composed with `fiscal_year_start_month` (company when one is in scope, else org).
- CLOSING entries (`entry_type = 'CLOSING'`) are **excluded from P&L activity** and included in
  balances (a closed year's P&L is not zeroed; retained earnings carry it).
- Balance sheets always include the synthetic equity rows `__re_prior` ("Retained earnings —
  prior years (not yet closed)") and `__ni_current` ("Net income (current year)").

## 3. Request → result

```ts
import { runReport } from '@/lib/reports/engine/adapter';      // server
const result = await runReport({ supabase, orgId, userId }, {
  statement: 'income_statement',          // | balance_sheet | cash_flow | equity_changes | trial_balance | gl_summary
  scope: { companyIds: [], consolidate: false },   // [] = every company in the caller's client scope
  period: { preset: 'ytd', asOf: '2026-10-24' },   // month | quarter | year | mtd | qtd | ytd | ttm | custom{start,end}
  columns: 'month',                       // single | month | quarter | year | company | department | class | job
  columnCount: 12, ttmColumn: true,
  compare: ['prior_year', 'budget'],      // prior_period | prior_year | budget | forecast (latest estimate)
  basis: 'ACCRUAL',                       // | CASH (P&L) | TAX | CUSTOM (+ customBasisLabel)
  rounding: 'thousands',                  // cents | units | thousands | millions (display only)
  commonSize: true, showZeroRows: false,
  filters: { departmentIds: [/* uuid */], accountRanges: [{ from: '6000', to: '6999' }] },
  layout: { kind: 'standard' },           // | { kind: 'ebitda' } | { kind: 'custom', layoutId }
});
```

`ReportResult`: `{ title, subtitle, basis, basisLabel, range, columns[], rows[], warnings[], notes[],
checks[], chartSeries[], companies[], governance }`.

- **Columns** (`ReportColumn`): `kind` = amount | total | elimination | variance_amount |
  variance_pct | common_size | debit | credit; `source` = actual | budget | forecast; `of` /
  `against` link derived columns; `drill` = the `DrillScope` for its cells; `status` = final
  (every month hard-closed) | preliminary | partial (in progress); `current`; `percent`.
- **Rows** (`ReportRow`): `kind` = header | group | account | subtotal | total | formula | spacer |
  check; `depth`, `parentId` (collapse tree); `accountIds` (drill); `values[]` aligned to
  columns; `fu[]` (F/U per variance column); `goodWhen` (up / down); `sumOf` (tie rule);
  `percent` (formula rows); `cellDrill[]` (per-cell drill overrides, e.g. TB P&L rows).
- **Checks**: balance sheet `A = L + E` per column; trial balance `Dr = Cr` per pair; cash flow
  "ending cash ties to the balance sheet" per column.
- **chartSeries** (for 3C): one series per key row (`rev`, `gp`, `op`/`ebitda`, `ni`; BS `ta`,
  `tl`, `eq`; CF `cfo`, `net`) over the base amount columns, cents.
- Built-in row ids (stable, for 3B / 3E): P&L standard `rev, cogs, gp, gm, opex, op, oi, oe, noi,
  ni, nm`; EBITDA `rev, cogs, gp, gm, opex, oi, ebitda, ebitda_m, da, int, tax, ni, nm`; BS `ca, fa,
  oa, ta, cl, ltl, tl, eq, tle, wc, cr`; CF `ni, adj_g, wc_g, cfo, cfi, cff, net, beg, end, bs_cash`.
- Comparisons attach to every amount column when `columns: 'single'` (or `compareEach: true`),
  otherwise to the Total (or Consolidated) column only.

### Consolidation

`scope.consolidate: true` + `columns: 'company'` → companies, **Combined** (FULL entities),
**Eliminations** (explicit account map from `lib/consolidation/consolidate.ts`: `is_eliminating`
accounts + INTERCOMPANY_AR/AP whose counterparty is inside the group), **Consolidated** =
Combined + Eliminations. With other column modes every cell is consolidated. Warnings:
`ELIMINATION_RESIDUAL`, `NON_FULL_ENTITIES`; NCI in `notes`.

### Basis

ACCRUAL = the store. TAX / CUSTOM = `reporting_basis_adjustments` (signed natural deltas; whole-year
rows pinned to the fiscal year's last month). CASH = the live conversion
(`fetchCashIncomeStatement` + `deriveCashAdjustments`) per P&L cell (max 8 cells; warns beyond).
A cash-basis balance sheet is not derived (warning `BASIS_LIMITED`).

## 4. Drill

```ts
import { runDrill } from '@/lib/reports/engine/adapter';
const page = await runDrill(ctx, { accountIds: row.accountIds, ...column.drill, limit: 100, offset: 0 });
// { totalCount, debitCents, creditCents, netCents, lines[{ entryHref, sourceHref, runningNetCents, … }] }
```

Lines come from `gl_entry_lines` (the ledger, not the store), so `drillSign × netCents === cell`
proves the figure. `dims` value `null` = Unassigned (IS NULL). Use `row.cellDrill[i]` when present.
Pass the scope's `windows` through unchanged (per-company in-group date bounds, §6).
HTTP: `POST /api/reports/engine/drill`.

Subtotal rows (gross profit, operating income, net income, total assets, total liabilities…)
are drillable too: when every term of a subtotal contributes with the same debit-sign
(GP = −Σ(revenue ∪ cost of sales)), the row carries the union of its accounts and that
`drillSign`. Subtotals mixing signs or containing the synthetic earnings rows (total equity,
total liabilities + equity) and formula rows are not drillable.

## 5. Balances for metrics (3B)

```ts
import { loadBalances, loadEngineFeed } from '@/lib/reports/engine/adapter';
const rows = await loadBalances(supabase, orgId, { companyIds, from: '2025-01-01', to: '2026-12-31', opening: true, dims: ['department'] });
// BalanceRow[] { companyId, accountId, period ('YYYY-MM-01' | null = opening), kind, departmentId…, debit, credit }
const feed = await loadEngineFeed(ctx, { companyIds, from: '2025-01', to: '2026-12', includeBudgets: true });
// structurally satisfies lib/metrics/adapters/period-balances.ts PeriodBalanceFeed
```

Months a range cuts mid-month are read at exact dates from the ledger (`report_balances` handles
it). `loadReportData()` exposes the planned `EngineData` if a consumer needs everything.
Note: `budgets` (mig 013) has no version column — every budget row is summed; "approved" budget
years come from `budget_versions.is_active`.

**Servers use `createMetricSource(ctx, { today })`** (`lib/metrics/server-source.ts`): ledger
classes + budgets from `loadEngineFeed`, sub-ledger inputs from the GL-query adapter. If the store
RPC is missing (`isStoreUnavailable(e)`), the whole load falls back to the GL-query adapter; any
other error (incl. `EngineScopeError`) propagates.

**3E flux** uses `periodBalanceFluxSource(db, orgId)` (`lib/close/flux/period-balance-source.ts`)
by default: ending balances from `report_balances` (`loadBalances(…, { from: null, to })`), posted
line detail from the ledger (drivers need memo / entry / counterparty). Same missing-store
fallback.

## 6. Governance (3D)

`adapter.ts` imports `@/lib/reports/governance`, which registers two hooks
(`lib/reports/engine/governance-hook.ts`):

1. **Membership — before aggregation.** `resolveMembership({ months, companyIds, scopeKind }, ctx)`
   returns in-group windows (`GroupWindow { from, until }`, month starts) for the companies whose
   window applies to this caller and scope (3D `report_company_coverage`; a combined /
   consolidated view, or a non-finance reader; never a finance user reading one company, never
   pro forma). `runReport` puts them on `EngineData.groupWindows` and the Ledger then:
   - **flows** (P&L, cash-flow activity, equity activity): keeps a company's rows only for months
     inside its window;
   - **point-in-time** (balance sheet, opening / closing cash and equity): keeps a company — its
     whole history — only when the as-of month is inside its window (its balance sheet arrives
     whole); a company that joined during the fiscal year carries its pre-joining P&L in
     "Retained earnings — prior years", so current-year net income equals the group's P&L;
   - **cash flow** adds `inv:group_change` "Cash of companies joining (leaving) the group" and
     **changes in equity** adds a `grp` column, so beginning + flows + joining = ending still ties;
   - budgets outside a window are dropped; consolidation inputs follow the same rule;
   - every `DrillScope` is narrowed to match (`companyIds` and per-company `windows`), so the
     drill still reproduces the cell; the RPC reads `p_dims.windows`.
   The trial balance and GL summary are ledger tools and are **not** windowed (governance
   annotates them). `result.groupWindowCompanyIds` lists the companies a window was applied to.
2. **Governance — after build.** `applyGovernance(view, ctx)` (release cut-off, books closed
   through, restatements, watermark; withholds unreleased columns). It must not change released
   figures. For companies in `groupWindowCompanyIds` its note says the company "is shown from
   <month>" instead of "includes months before then".

Tests that exercise the engine without Clerk call `registerGovernance(null)` /
`registerMembership(null)` (or register a stub).

## 7. HTTP surface

| Route | Method | Permission | Body / result |
|---|---|---|---|
| `/api/reports/engine/run` | POST | reports:view | `ReportRequest` (+ `reportKey`) → `{ data: ReportResult }`; 403 `CLIENT_SCOPE_DENIED` |
| `/api/reports/engine/drill` | POST | reports:view | `DrillRequest` → `{ data: DrillResult }` |
| `/api/reports/engine/meta` | GET | reports:view | companies in scope, departments, classes, account groups, roles, layouts |
| `/api/reports/engine/tie-out` | GET | close_mgmt:view | `{ tied, mismatches[] }` |
| `/api/reports/engine/prefs` | GET / POST | reports:view | favourites + recently run |
| `/api/reports/engine/layouts` | GET / POST | reports:export (write) | custom layouts |
| `/api/reports/engine/layouts/[id]` | PATCH / DELETE | reports:export | update / archive |

Exports reuse `/api/reports/export/{pdf,xlsx}` with `toStatementModel(result)`; saved views reuse
`/api/reports/views` (`config.engine` + `config.query`).

## 8. Store maintenance

- Repair: `select public.rebuild_period_balances('<org>')` (service role).
- Proof: `select * from public.period_balances_tieout('<org>')` → no rows = tied.
- Triggers: `trg_pb_line_change` (lines), `trg_pb_header_update` (status / date / type),
  `trg_pb_header_delete` (purge / rollback). SECURITY DEFINER; EXECUTE revoked from members.
