export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { resolveRole, PostingError, type AccountRoleKey } from '@/lib/posting/account-roles';
import {
  computeDirectCashFlow,
  type CounterpartLeg,
  type DirectRoleTag,
} from '@/lib/forecast/cash-flow-direct';
import { z } from 'zod';

/**
 * GET /api/reports/cash-flow-direct?start_date=&end_date=&location_ids=
 *
 * DIRECT-METHOD statement of cash flows. Reads every POSTED journal entry that
 * touched a cash / equivalent account in the period, decomposes each into its
 * cash legs and counterpart legs, and classifies the counterpart legs into
 * direct-method lines (cash from customers, to suppliers, to employees, …). The
 * reported net change MUST tie to the independently measured cash movement — the
 * response carries the reconciliation variance.
 *
 * SECURITY: RLS-scoped (runs AS THE USER) + reports:view permission gate.
 */

const querySchema = z.object({
  location_id: z.string().optional(),
  location_ids: z.string().optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** Role → tag map: each role, when resolved, tags the account ids it maps to. */
const ROLE_TAGS: { role: AccountRoleKey; tag: DirectRoleTag }[] = [
  { role: 'AR_CONTROL', tag: 'AR_CONTROL' },
  { role: 'UNBILLED_RECEIVABLE', tag: 'UNBILLED_RECEIVABLE' },
  { role: 'RETAINAGE_RECEIVABLE', tag: 'RETAINAGE_RECEIVABLE' },
  { role: 'CUSTOMER_DEPOSITS', tag: 'CUSTOMER_DEPOSITS' },
  { role: 'DEFERRED_REVENUE', tag: 'DEFERRED_REVENUE' },
  { role: 'ALLOWANCE_DOUBTFUL', tag: 'ALLOWANCE_DOUBTFUL' },
  { role: 'AP_CONTROL', tag: 'AP_CONTROL' },
  { role: 'ACCRUED_EXPENSES', tag: 'ACCRUED_EXPENSES' },
  { role: 'CREDIT_CARD_PAYABLE', tag: 'CREDIT_CARD_PAYABLE' },
  { role: 'RETAINAGE_PAYABLE', tag: 'RETAINAGE_PAYABLE' },
  { role: 'WAGES_EXPENSE', tag: 'WAGES_EXPENSE' },
  { role: 'PAYROLL_TAX_EXPENSE', tag: 'PAYROLL_TAX_EXPENSE' },
  { role: 'FEDERAL_TAX_PAYABLE', tag: 'FEDERAL_TAX_PAYABLE' },
  { role: 'STATE_TAX_PAYABLE', tag: 'STATE_TAX_PAYABLE' },
  { role: 'FICA_PAYABLE', tag: 'FICA_PAYABLE' },
  { role: 'HEALTH_INSURANCE_PAYABLE', tag: 'HEALTH_INSURANCE_PAYABLE' },
  { role: 'RETIREMENT_PAYABLE', tag: 'RETIREMENT_PAYABLE' },
  { role: 'WORKERS_COMP_PAYABLE', tag: 'WORKERS_COMP_PAYABLE' },
  { role: 'GARNISHMENT_PAYABLE', tag: 'GARNISHMENT_PAYABLE' },
  { role: 'HEALTH_INSURANCE_EXPENSE', tag: 'HEALTH_INSURANCE_EXPENSE' },
  { role: 'RETIREMENT_MATCH_EXPENSE', tag: 'RETIREMENT_MATCH_EXPENSE' },
  { role: 'WORKERS_COMP_EXPENSE', tag: 'WORKERS_COMP_EXPENSE' },
  { role: 'OWNERS_DRAW', tag: 'OWNERS_DRAW' },
  { role: 'OWNERS_CAPITAL', tag: 'OWNERS_CAPITAL' },
];

interface AcctMeta {
  type: string;
  subType: string;
  name: string;
  isBank: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveRoleId(supabase: any, orgId: string, role: AccountRoleKey): Promise<string | null> {
  try {
    const ref = await resolveRole(supabase, orgId, role);
    return ref.id;
  } catch (e) {
    if (e instanceof PostingError) return null;
    throw e;
  }
}

export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'reports', 'view');
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(request.url);
  const params = querySchema.parse(Object.fromEntries(searchParams.entries()));
  const locFilter = params.location_ids
    ? params.location_ids.split(',').filter(Boolean)
    : params.location_id && params.location_id !== 'all'
      ? [params.location_id]
      : [];

  // ── Account metadata + role tags (by ROLE, never by number) ──
  const { data: accts } = await supabase
    .from('accounts')
    .select('id, account_type, account_sub_type, is_bank_account, name');
  const acctMeta = new Map<string, AcctMeta>();
  for (const a of accts ?? []) {
    acctMeta.set(a.id as string, {
      type: (a.account_type as string) ?? '',
      subType: (a.account_sub_type as string) ?? '',
      name: (a.name as string) ?? '',
      isBank: Boolean(a.is_bank_account),
    });
  }

  // Cash / equivalent account ids — the reconciling set (never a section line).
  const cashIds = new Set<string>();
  for (const [id, m] of acctMeta) if (m.isBank) cashIds.add(id);
  for (const role of ['CASH_ON_HAND', 'UNDEPOSITED_FUNDS', 'OPERATING_BANK', 'SETTLEMENT_CLEARING', 'PAYMENTS_IN_TRANSIT'] as AccountRoleKey[]) {
    const id = await resolveRoleId(supabase, orgId, role);
    if (id) cashIds.add(id);
  }

  // Role tags per account id.
  const tagsByAccount = new Map<string, DirectRoleTag[]>();
  for (const { role, tag } of ROLE_TAGS) {
    const id = await resolveRoleId(supabase, orgId, role);
    if (!id) continue;
    const arr = tagsByAccount.get(id) ?? [];
    arr.push(tag);
    tagsByAccount.set(id, arr);
  }

  // ── Posted entries in the period (RLS scopes to this org) ──
  let entriesQ = supabase
    .from('gl_entries')
    .select('id')
    .eq('status', 'POSTED')
    .gte('entry_date', params.start_date)
    .lte('entry_date', params.end_date);
  if (locFilter.length === 1) entriesQ = entriesQ.eq('location_id', locFilter[0]);
  else if (locFilter.length > 1) entriesQ = entriesQ.in('location_id', locFilter);

  const { data: entryRows } = await entriesQ;
  const entryIds = (entryRows ?? []).map((e: { id: string }) => e.id);

  const emptyResult = () =>
    NextResponse.json({
      period: { startDate: params.start_date, endDate: params.end_date },
      method: 'direct',
      operating: { lines: [], totalCents: 0 },
      investing: { lines: [], totalCents: 0 },
      financing: { lines: [], totalCents: 0 },
      netChangeCents: 0,
      beginningCashCents: 0,
      endingCashCents: 0,
      varianceCents: 0,
      reconciled: true,
      meta: { entryCount: 0, cashMovingEntryCount: 0, consolidated: locFilter.length === 0 },
    });

  if (entryIds.length === 0) return emptyResult();

  // ── Fetch lines in chunks (bounded IN lists) ──
  interface LineRow { gl_entry_id: string; account_id: string; debit_cents: number | string | null; credit_cents: number | string | null }
  const lines: LineRow[] = [];
  const CHUNK = 500;
  for (let i = 0; i < entryIds.length; i += CHUNK) {
    const slice = entryIds.slice(i, i + CHUNK);
    const { data: l } = await supabase
      .from('gl_entry_lines')
      .select('gl_entry_id, account_id, debit_cents, credit_cents')
      .in('gl_entry_id', slice);
    if (l) lines.push(...(l as LineRow[]));
  }

  // Group by entry so we only classify entries that actually MOVE cash.
  const byEntry = new Map<string, LineRow[]>();
  for (const l of lines) {
    const arr = byEntry.get(l.gl_entry_id) ?? [];
    arr.push(l);
    byEntry.set(l.gl_entry_id, arr);
  }

  const counterpartLegs: CounterpartLeg[] = [];
  let netCashChange = 0;
  let cashMovingEntryCount = 0;

  for (const [, entryLines] of byEntry) {
    let entryCashDelta = 0;
    let touchesCash = false;
    for (const l of entryLines) {
      if (cashIds.has(l.account_id)) {
        touchesCash = true;
        entryCashDelta += Number(l.debit_cents ?? 0) - Number(l.credit_cents ?? 0);
      }
    }
    if (!touchesCash) continue; // not a cash-flow entry
    cashMovingEntryCount += 1;
    netCashChange += entryCashDelta;
    for (const l of entryLines) {
      if (cashIds.has(l.account_id)) continue; // cash legs are the reconciling side
      const m = acctMeta.get(l.account_id);
      if (!m) continue;
      counterpartLegs.push({
        accountType: m.type,
        accountSubType: m.subType,
        accountName: m.name,
        debitCents: Number(l.debit_cents ?? 0),
        creditCents: Number(l.credit_cents ?? 0),
        roleTags: tagsByAccount.get(l.account_id),
      });
    }
  }

  // ── Beginning cash: running cash balance before the period start ──
  let beginningCash = 0;
  if (cashIds.size > 0) {
    let priorQ = supabase
      .from('gl_entries')
      .select('id')
      .eq('status', 'POSTED')
      .lt('entry_date', params.start_date);
    if (locFilter.length === 1) priorQ = priorQ.eq('location_id', locFilter[0]);
    else if (locFilter.length > 1) priorQ = priorQ.in('location_id', locFilter);
    const { data: priorEntries } = await priorQ;
    const priorIds = (priorEntries ?? []).map((e: { id: string }) => e.id);
    const cashIdArr = Array.from(cashIds);
    for (let i = 0; i < priorIds.length; i += CHUNK) {
      const slice = priorIds.slice(i, i + CHUNK);
      const { data: cashLines } = await supabase
        .from('gl_entry_lines')
        .select('debit_cents, credit_cents')
        .in('gl_entry_id', slice)
        .in('account_id', cashIdArr);
      for (const cl of cashLines ?? []) {
        beginningCash += Number(cl.debit_cents ?? 0) - Number(cl.credit_cents ?? 0);
      }
    }
  }

  const result = computeDirectCashFlow({
    beginningCashCents: beginningCash,
    netCashChangeCents: netCashChange,
    legs: counterpartLegs,
  });

  return NextResponse.json({
    period: { startDate: params.start_date, endDate: params.end_date },
    method: 'direct',
    operating: result.operating,
    investing: result.investing,
    financing: result.financing,
    netChangeCents: result.netChangeCents,
    beginningCashCents: result.beginningCashCents,
    endingCashCents: result.endingCashCents,
    varianceCents: result.varianceCents,
    reconciled: result.reconciled,
    meta: {
      entryCount: entryIds.length,
      cashMovingEntryCount,
      consolidated: locFilter.length === 0,
      generatedAt: new Date().toISOString(),
    },
  });
}
