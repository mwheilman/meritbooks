export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { resolveRole, PostingError, type AccountRoleKey } from '@/lib/posting/account-roles';
import { summarizeObligations, type ObligationItem } from '@/lib/cash/obligations';

/**
 * GET /api/cash/obligations?location_id=<uuid>
 *
 * Near-term committed cash outflows for the Cash Position screen: scheduled
 * debt-service payments (from each loan's amortization schedule, unpaid + due
 * within 90 days) plus recurring outflows (payroll / lease / recurring bills
 * from active recurring-JE templates, expanded by cadence across the horizon).
 *
 * Lets a treasurer see what's due against the live balance. Read-only,
 * RLS-scoped, deterministic. Degrade-safe: nothing scheduled → empty summary.
 */

const HORIZON_DAYS = 90;
const CASH_ACCOUNT_TYPES = ['CHECKING', 'SAVINGS'];

const FREQ_MONTHS: Record<string, number> = { MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUALLY: 12, ANNUAL: 12 };

interface InstrumentRow { id: string; name: string; lender: string | null; location_id: string | null; status: string }
interface ScheduleRow {
  instrument_id: string; period: number; period_date: string | null;
  payment_cents: number | string | null; interest_cents: number | string | null; principal_cents: number | string | null;
}
interface BankAccountRow { current_balance_cents: number | string | null; account_type: string | null }
interface TemplateRow {
  id: string; name: string; frequency: string; next_run_date: string | null;
  start_date: string | null; end_date: string | null; template_lines: unknown; location_id: string | null;
}

function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
function addMonthsIso(iso: string, months: number): string {
  const [y, m, day] = iso.slice(0, 10).split('-').map(Number);
  const base = new Date(Date.UTC(y, (m - 1) + months, 1));
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(day, lastDay));
  return isoDate(base);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveRoleId(supabase: any, orgId: string, role: AccountRoleKey): Promise<string | null> {
  try { return (await resolveRole(supabase, orgId, role)).id; }
  catch (e) { if (e instanceof PostingError) return null; throw e; }
}

export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const locationId = new URL(request.url).searchParams.get('location_id');
  const today = new Date();
  const anchor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const todayIso = isoDate(anchor);
  const horizonEnd = new Date(anchor);
  horizonEnd.setUTCDate(horizonEnd.getUTCDate() + HORIZON_DAYS);
  const horizonEndIso = isoDate(horizonEnd);

  // 1. Current operating cash (CHECKING/SAVINGS) — what obligations are measured against.
  let cashQ = supabase
    .from('bank_accounts')
    .select('current_balance_cents, account_type')
    .eq('is_active', true)
    .in('account_type', CASH_ACCOUNT_TYPES);
  if (locationId) cashQ = cashQ.eq('location_id', locationId);
  const { data: cashData, error: cashErr } = await cashQ;
  if (cashErr) return NextResponse.json({ error: cashErr.message }, { status: 500 });
  const currentCashCents = ((cashData ?? []) as BankAccountRow[]).reduce((s, a) => s + Number(a.current_balance_cents ?? 0), 0);

  const items: ObligationItem[] = [];

  // 2. Scheduled debt-service payments (ACTIVE loans, unpaid, due within horizon).
  let instQ = supabase.from('debt_instruments').select('id, name, lender, location_id, status').eq('status', 'ACTIVE');
  if (locationId) instQ = instQ.eq('location_id', locationId);
  const { data: instData, error: instErr } = await instQ;
  if (instErr) return NextResponse.json({ error: instErr.message }, { status: 500 });
  const instruments = (instData ?? []) as InstrumentRow[];
  const instById = new Map(instruments.map((i) => [i.id, i]));

  if (instruments.length > 0) {
    const { data: lineData } = await supabase
      .from('debt_schedule_lines')
      .select('instrument_id, period, period_date, payment_cents, interest_cents, principal_cents')
      .in('instrument_id', instruments.map((i) => i.id))
      .gte('period_date', todayIso)
      .lte('period_date', horizonEndIso)
      .order('period_date', { ascending: true });
    const lines = (lineData ?? []) as ScheduleRow[];

    // Which payment periods already posted? (source_ref guard, same as /api/debt/[id]).
    const paid = new Set<string>();
    if (lines.length > 0) {
      const { data: entries } = await supabase
        .from('gl_entries')
        .select('source_ref')
        .eq('source_module', 'DEBT')
        .neq('status', 'VOIDED')
        .like('source_ref', 'debt:payment:%');
      for (const e of (entries ?? []) as { source_ref: string | null }[]) {
        if (e.source_ref) paid.add(e.source_ref);
      }
    }

    for (const l of lines) {
      const pay = Number(l.payment_cents ?? 0);
      if (pay <= 0 || !l.period_date) continue;
      if (paid.has(`debt:payment:${l.instrument_id}:${l.period}`)) continue;
      const inst = instById.get(l.instrument_id);
      items.push({
        id: `debt:${l.instrument_id}:${l.period}`,
        kind: 'DEBT',
        label: inst?.name ?? 'Loan payment',
        party: inst?.lender ?? null,
        dueDate: l.period_date,
        amountCents: pay,
        interestCents: Number(l.interest_cents ?? 0),
        principalCents: Number(l.principal_cents ?? 0),
      });
    }
  }

  // 3. Recurring outflows — active recurring-JE templates whose net cash effect is
  //    an outflow, expanded by cadence across the horizon.
  let tplQ = supabase
    .from('recurring_templates')
    .select('id, name, frequency, next_run_date, start_date, end_date, template_lines, location_id')
    .eq('is_active', true);
  if (locationId) tplQ = tplQ.eq('location_id', locationId);
  const { data: tplData } = await tplQ;
  const templates = (tplData ?? []) as TemplateRow[];

  if (templates.length > 0) {
    // Resolve the set of cash-account ids (bank flag + operating roles), same as
    // the driver forecast, so we can measure each template's net cash delta.
    const { data: accts } = await supabase.from('accounts').select('id, is_bank_account');
    const cashIds = new Set<string>();
    for (const a of (accts ?? []) as { id: string; is_bank_account: boolean }[]) if (a.is_bank_account) cashIds.add(a.id);
    for (const role of ['CASH_ON_HAND', 'UNDEPOSITED_FUNDS', 'OPERATING_BANK'] as AccountRoleKey[]) {
      const id = await resolveRoleId(supabase, orgId, role);
      if (id) cashIds.add(id);
    }

    for (const t of templates) {
      const months = FREQ_MONTHS[t.frequency];
      if (!months) continue;
      const lines = Array.isArray(t.template_lines) ? (t.template_lines as Array<Record<string, unknown>>) : [];
      let cashDelta = 0;
      for (const ln of lines) {
        const acctId = ln.account_id as string | undefined;
        if (!acctId || !cashIds.has(acctId)) continue;
        cashDelta += Number(ln.debit_cents ?? 0) - Number(ln.credit_cents ?? 0);
      }
      if (cashDelta >= 0) continue; // only outflows are obligations
      const outflow = Math.abs(cashDelta);

      // Expand occurrences from next_run_date/start forward until the horizon end.
      let occ = t.next_run_date ?? t.start_date ?? todayIso;
      const endLimit = t.end_date && t.end_date < horizonEndIso ? t.end_date : horizonEndIso;
      let guard = 0;
      // Fast-forward past occurrences into the window.
      while (occ < todayIso && guard < 60) { occ = addMonthsIso(occ, months); guard += 1; }
      while (occ <= endLimit && guard < 60) {
        items.push({ id: `tpl:${t.id}:${occ}`, kind: 'RECURRING', label: t.name, party: null, dueDate: occ, amountCents: outflow });
        occ = addMonthsIso(occ, months);
        guard += 1;
      }
    }
  }

  const summary = summarizeObligations({ currentCashCents, items, today: anchor });

  return NextResponse.json({
    ...summary,
    debtItemCount: items.filter((i) => i.kind === 'DEBT').length,
    recurringItemCount: items.filter((i) => i.kind === 'RECURRING').length,
    meta: { locationId: locationId ?? null, consolidated: !locationId, horizonDays: HORIZON_DAYS },
  });
}
