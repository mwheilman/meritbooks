/**
 * Paginated, sortable, filterable list reads for every dealer object (RLS client).
 * Each list declares its sortable columns and filters explicitly — nothing from the
 * query string reaches PostgREST unless it is on the allow-list.
 */

import { resolvePageParams, totalPages } from '@/lib/pagination';
import type { DealerCtx } from './context';
import { dbFail } from './errors';
import { coerceMoney } from './rows';

export type DealerListKind =
  | 'units'
  | 'notes'
  | 'transactions'
  | 'curtailments'
  | 'lines'
  | 'programs'
  | 'sales'
  | 'trade_ins'
  | 'warranty'
  | 'oem_programs'
  | 'incentives'
  | 'lender_statements'
  | 'lender_statement_lines'
  | 'oem_statements'
  | 'oem_statement_lines'
  | 'claim_events'
  | 'imports';

interface ListSpec {
  table: string;
  sortable: readonly string[];
  defaultSort: string;
  /** Equality filters (query param = column). */
  filters: readonly string[];
  /** ilike search over these columns (q=). */
  search?: readonly string[];
  /** Date range filter column (from= / to=). */
  dateColumn?: string;
}

export const LIST_SPECS: Record<DealerListKind, ListSpec> = {
  units: {
    table: 'dealer_units',
    sortable: ['serial_number', 'stock_number', 'model', 'model_year', 'status', 'condition', 'received_date', 'sold_date', 'cost_cents', 'created_at'],
    defaultSort: 'received_date',
    filters: ['status', 'condition', 'make_vendor_id', 'inventory_role', 'is_consignment', 'source', 'import_batch_id'],
    search: ['serial_number', 'stock_number', 'model', 'vin_hin'],
    dateColumn: 'received_date',
  },
  notes: {
    table: 'floor_plan_notes',
    sortable: ['floored_date', 'lender_invoice_number', 'principal_balance_cents', 'original_principal_cents', 'status', 'maturity_date', 'payoff_due_date'],
    defaultSort: 'floored_date',
    filters: ['status', 'line_id', 'program_id', 'unit_id', 'collateral_type', 'import_batch_id'],
    search: ['lender_invoice_number', 'description'],
    dateColumn: 'floored_date',
  },
  transactions: {
    table: 'floor_plan_transactions',
    sortable: ['txn_date', 'txn_type', 'status', 'principal_cents', 'interest_cents', 'created_at'],
    defaultSort: 'txn_date',
    filters: ['txn_type', 'status', 'line_id', 'note_id'],
    dateColumn: 'txn_date',
  },
  curtailments: {
    table: 'floor_plan_curtailments',
    sortable: ['due_date', 'amount_cents', 'status'],
    defaultSort: 'due_date',
    filters: ['status', 'note_id'],
    dateColumn: 'due_date',
  },
  lines: { table: 'floor_plan_lines', sortable: ['name', 'credit_limit_cents', 'status', 'created_at'], defaultSort: 'name', filters: ['status', 'lender_vendor_id'], search: ['name'] },
  programs: { table: 'floor_plan_programs', sortable: ['name', 'rate_bps', 'free_floor_days', 'effective_from', 'status'], defaultSort: 'name', filters: ['line_id', 'oem_vendor_id', 'status'], search: ['name'] },
  sales: {
    table: 'dealer_unit_sales',
    sortable: ['sale_date', 'sale_price_cents', 'status', 'source', 'created_at'],
    defaultSort: 'sale_date',
    filters: ['status', 'source', 'unit_id', 'customer_id', 'posting_mode', 'import_batch_id'],
    search: ['external_deal_ref', 'salesperson'],
    dateColumn: 'sale_date',
  },
  trade_ins: { table: 'trade_ins', sortable: ['created_at', 'allowance_cents', 'acv_cents', 'status', 'lien_status'], defaultSort: 'created_at', filters: ['status', 'lien_status', 'sale_id'], search: ['serial_number', 'model'] },
  warranty: {
    table: 'warranty_claims',
    sortable: ['submitted_date', 'filing_deadline', 'claimed_cents', 'settled_cents', 'status', 'repair_date', 'created_at'],
    defaultSort: 'created_at',
    filters: ['status', 'oem_vendor_id', 'unit_id', 'import_batch_id'],
    search: ['oem_claim_number', 'dealer_claim_ref', 'repair_order_ref', 'serial_number'],
    dateColumn: 'submitted_date',
  },
  oem_programs: { table: 'oem_programs', sortable: ['name', 'start_date', 'end_date', 'status', 'program_type'], defaultSort: 'name', filters: ['status', 'oem_vendor_id', 'program_type', 'treatment'], search: ['name', 'program_code'] },
  incentives: {
    table: 'oem_incentive_claims',
    sortable: ['earned_date', 'claim_deadline', 'accrued_cents', 'settled_cents', 'status'],
    defaultSort: 'earned_date',
    filters: ['status', 'program_id', 'unit_id', 'sale_id', 'treatment'],
    search: ['claim_reference'],
    dateColumn: 'earned_date',
  },
  lender_statements: { table: 'lender_statements', sortable: ['statement_date', 'kind', 'status'], defaultSort: 'statement_date', filters: ['line_id', 'kind', 'status'], dateColumn: 'statement_date' },
  lender_statement_lines: {
    table: 'lender_statement_lines',
    sortable: ['line_number', 'match_status', 'variance_cents', 'current_cents'],
    defaultSort: 'line_number',
    filters: ['statement_id', 'match_status', 'sau_flag', 'matched_note_id'],
    search: ['lender_invoice_number', 'serial_number', 'model'],
  },
  oem_statements: { table: 'oem_statements', sortable: ['statement_date', 'status'], defaultSort: 'statement_date', filters: ['oem_vendor_id', 'status'], dateColumn: 'statement_date' },
  oem_statement_lines: {
    table: 'oem_statement_lines',
    sortable: ['line_number', 'amount_cents', 'match_status', 'line_type'],
    defaultSort: 'line_number',
    filters: ['statement_id', 'match_status', 'line_type'],
    search: ['reference', 'serial_number', 'description'],
  },
  claim_events: { table: 'dealer_claim_events', sortable: ['event_date', 'created_at', 'amount_cents'], defaultSort: 'created_at', filters: ['claim_kind', 'warranty_claim_id', 'incentive_claim_id', 'event_type'], dateColumn: 'event_date' },
  imports: { table: 'dealer_import_batches', sortable: ['created_at', 'status', 'file_kind'], defaultSort: 'created_at', filters: ['status', 'file_kind', 'source_system'] },
};

export interface ListParams {
  page?: string;
  per_page?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
  q?: string;
  from?: string;
  to?: string;
  /** Equality filters by column name (only allow-listed ones apply). */
  filters?: Record<string, string | undefined>;
}

export interface ListResult<T> {
  rows: T[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  sort: string;
  dir: 'asc' | 'desc';
}

const SAFE_SEARCH = /[,()*\\%]/g;

export async function listDealer<T = Record<string, unknown>>(d: Pick<DealerCtx, 'db' | 'orgId' | 'locationId'>, kind: DealerListKind, p: ListParams): Promise<ListResult<T>> {
  const spec = LIST_SPECS[kind];
  const page = resolvePageParams({ page: p.page, per_page: p.per_page });
  const sort = p.sort && spec.sortable.includes(p.sort) ? p.sort : spec.defaultSort;
  const dir = p.dir === 'asc' ? 'asc' : 'desc';

  let q = d.db.from(spec.table).select('*', { count: 'exact' }).eq('org_id', d.orgId).eq('location_id', d.locationId);
  for (const col of spec.filters) {
    const v = p.filters?.[col];
    if (v === undefined || v === '') continue;
    if (v === 'true' || v === 'false') q = q.eq(col, v === 'true');
    else if (v.includes(',')) q = q.in(col, v.split(',').map((x) => x.trim()).filter(Boolean));
    else q = q.eq(col, v);
  }
  if (p.q && spec.search?.length) {
    const term = p.q.replace(SAFE_SEARCH, ' ').trim();
    if (term) q = q.or(spec.search.map((c) => `${c}.ilike.%${term}%`).join(','));
  }
  if (spec.dateColumn && p.from) q = q.gte(spec.dateColumn, p.from);
  if (spec.dateColumn && p.to) q = q.lte(spec.dateColumn, p.to);
  q = q.order(sort, { ascending: dir === 'asc', nullsFirst: false }).order('id', { ascending: true }).range(page.rangeFrom, page.rangeTo);

  const { data, error, count } = await q;
  if (error) dbFail(`Listing ${kind} failed`, error);
  return {
    rows: ((data ?? []) as Record<string, unknown>[]).map((r) => coerceMoney<T>(r)),
    page: page.page,
    perPage: page.perPage,
    total: count ?? 0,
    totalPages: totalPages(count ?? 0, page.perPage),
    sort,
    dir,
  };
}
