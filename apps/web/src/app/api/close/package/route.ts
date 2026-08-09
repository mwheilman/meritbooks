export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // Buffer + zlib (xlsx zip assembly) — not edge

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { gatherReconciliationCloseStatus } from '@/lib/services/reconciliation-close-gate';
import { gatherHardCloseGate } from '@/lib/close/readiness';
import { workbookFromModels } from '@/lib/reports/export/xlsx';
import { buildExportFilename, type StatementModel, type StmtRow } from '@/lib/reports/export/statement-model';

/**
 * Close Package — a per-period, per-entity close binder a controller can hand to a
 * partner or an auditor. Assembles, from the LIVE books (deterministic, AI-off):
 *
 *   1. Trial Balance ......... every account's debit/credit balance (proves the books
 *                              balance) — from v_trial_balance, RLS-scoped.
 *   2. Reconciliation Status . each bank account's reconciliation state for the period
 *                              (the must-tie close gate), with any blockers named.
 *   3. Journal Entry Listing . the period's posted journal entries with amounts.
 *   4. Open Items Summary .... the close-readiness checklist — every task's live
 *                              status + the hard-close gate verdict and its blockers.
 *
 * GET /api/close/package?year&month&location_id[&format=xlsx|json]
 *   format=xlsx (default) → a multi-worksheet .xlsx (reuses the report export writer,
 *                           zero new dependency); format=json → the same package as
 *                           structured data for on-screen preview.
 *
 * Every read runs through the RLS-scoped client — tenant isolation is enforced by the
 * database. All money is bigint cents.
 */

interface TbRow {
  account_number: string | null;
  account_name: string | null;
  account_type: string | null;
  total_debits: number | string | null;
  total_credits: number | string | null;
}
interface JeRow {
  entry_number: string | null;
  entry_date: string | null;
  memo: string | null;
  source_module: string | null;
  status: string | null;
  gl_entry_lines: { debit_cents: number | string | null }[] | null;
}

const num = (v: number | string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const now = new Date();
  const { searchParams } = new URL(request.url);
  const year = parseInt(searchParams.get('year') ?? String(now.getFullYear()), 10);
  const month = parseInt(searchParams.get('month') ?? String(now.getMonth() + 1), 10);
  const locationId = searchParams.get('location_id');
  const format = (searchParams.get('format') ?? 'xlsx').toLowerCase();
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: 'Invalid period', code: 'BAD_REQUEST' }, { status: 400 });
  }
  if (!locationId) {
    return NextResponse.json({ error: 'location_id is required', code: 'BAD_REQUEST' }, { status: 400 });
  }

  const periodLabel = new Date(year, month - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });

  // Entity + period.
  const [{ data: locRow }, { data: periodRow }] = await Promise.all([
    supabase.schema('core').from('locations').select('name, short_code').eq('id', locationId).maybeSingle(),
    supabase
      .from('fiscal_periods')
      .select('id, status, closed_at')
      .eq('location_id', locationId)
      .eq('period_year', year)
      .eq('period_month', month)
      .maybeSingle(),
  ]);
  const entityName = (locRow as { name: string } | null)?.name ?? 'Entity';
  const period = periodRow as { id: string; status: string; closed_at: string | null } | null;

  // The four sections — read in parallel where independent.
  const [tbRes, jeRes, recon, gateBundle] = await Promise.all([
    supabase
      .from('v_trial_balance')
      .select('account_number, account_name, account_type, total_debits, total_credits')
      .eq('location_id', locationId)
      .order('type_order')
      .order('sub_type_order')
      .order('group_order')
      .order('account_order'),
    period
      ? supabase
          .from('gl_entries')
          .select('entry_number, entry_date, memo, source_module, status, gl_entry_lines(debit_cents)')
          .eq('location_id', locationId)
          .eq('fiscal_period_id', period.id)
          .order('entry_date')
      : Promise.resolve({ data: [] as JeRow[], error: null }),
    period
      ? gatherReconciliationCloseStatus(supabase, { locationId, fiscalPeriodId: period.id }).catch(() => null)
      : Promise.resolve(null),
    period
      ? gatherHardCloseGate(supabase, orgId, { locationId, fiscalPeriodId: period.id }).catch(() => null)
      : Promise.resolve(null),
  ]);

  const tbRows = (tbRes.data ?? []) as TbRow[];
  const jeRows = (jeRes.data ?? []) as JeRow[];

  // ── Trial balance (debit / credit columns; totals must agree = balanced books) ──
  let tbTotalDebit = 0;
  let tbTotalCredit = 0;
  const tbLines = tbRows.map((r) => {
    const rawNet = num(r.total_debits) - num(r.total_credits);
    const debit = rawNet > 0 ? rawNet : 0;
    const credit = rawNet < 0 ? -rawNet : 0;
    tbTotalDebit += debit;
    tbTotalCredit += credit;
    return {
      accountNumber: r.account_number ?? '',
      accountName: r.account_name ?? '',
      accountType: r.account_type ?? '',
      debitCents: debit,
      creditCents: credit,
    };
  });

  // ── Journal entry listing (period, with per-entry debit total) ──
  const jeLines = jeRows.map((r) => {
    const amount = (r.gl_entry_lines ?? []).reduce((s, l) => s + num(l.debit_cents), 0);
    return {
      entryNumber: r.entry_number ?? '',
      entryDate: r.entry_date ?? '',
      memo: r.memo ?? '',
      source: r.source_module ?? 'MANUAL',
      status: r.status ?? '',
      amountCents: amount,
    };
  });
  const jePostedTotal = jeLines.filter((j) => j.status === 'POSTED').reduce((s, j) => s + j.amountCents, 0);

  // ── Open-items summary (the readiness checklist + hard-close verdict) ──
  const openItems = gateBundle
    ? {
        readyToHardClose: gateBundle.evaluation.readyToHardClose,
        percentComplete: gateBundle.evaluation.percentComplete,
        tasks: gateBundle.evaluation.tasks.map((t) => ({
          key: t.key,
          label: t.label,
          kind: t.kind,
          blocking: t.blocking,
          status: t.status,
          driverLabel: t.driverLabel,
        })),
        blockers: gateBundle.gate.blockers,
      }
    : null;

  const pkg = {
    meta: {
      entityName,
      periodLabel,
      year,
      month,
      periodStatus: period?.status ?? 'NO_PERIOD',
      closedAt: period?.closed_at ?? null,
      generatedAt: now.toISOString(),
    },
    trialBalance: { lines: tbLines, totalDebitCents: tbTotalDebit, totalCreditCents: tbTotalCredit, balanced: tbTotalDebit === tbTotalCredit },
    reconciliation: recon
      ? { accountsConsidered: recon.accountsConsidered, accountsReconciled: recon.accountsReconciled, blockers: recon.blockers }
      : null,
    journalEntries: { lines: jeLines, count: jeLines.length, postedTotalCents: jePostedTotal },
    openItems,
  };

  if (format === 'json') {
    return NextResponse.json(pkg);
  }

  // ── Assemble the .xlsx workbook (one worksheet per section) ──
  const metaFor = (title: string, periodOverride?: string): Pick<StatementModel, 'title' | 'entityLabel' | 'periodLabel' | 'generatedAt'> => ({
    title,
    entityLabel: entityName,
    periodLabel: periodOverride ?? periodLabel,
    generatedAt: pkg.meta.generatedAt,
  });

  const tbRowsModel: StmtRow[] = tbLines.map((l) => ({
    kind: 'account' as const,
    code: l.accountNumber,
    label: l.accountName,
    values: [l.debitCents, l.creditCents],
  }));
  tbRowsModel.push({ kind: 'total', code: '', label: 'Total', values: [tbTotalDebit, tbTotalCredit] });
  if (tbTotalDebit !== tbTotalCredit) {
    tbRowsModel.push({ kind: 'note', label: `Out of balance by ${((tbTotalDebit - tbTotalCredit) / 100).toFixed(2)}`, values: [null, null] });
  }
  const trialBalanceModel: StatementModel = {
    ...metaFor('Trial Balance'),
    columns: [
      { key: 'debit', label: 'Debit', money: true },
      { key: 'credit', label: 'Credit', money: true },
    ],
    rows: tbRowsModel,
  };

  const reconRows: StmtRow[] = [];
  if (recon) {
    reconRows.push({ kind: 'account', label: 'Bank accounts considered', values: [String(recon.accountsConsidered)] });
    reconRows.push({ kind: 'account', label: 'Accounts reconciled ($0 difference)', values: [String(recon.accountsReconciled)] });
    reconRows.push({ kind: 'spacer', label: '', values: [null] });
    if (recon.blockers.length === 0) {
      reconRows.push({ kind: 'note', label: 'All bank accounts are reconciled and tie for the period.', values: [null] });
    } else {
      reconRows.push({ kind: 'section', label: 'Open reconciliation items', values: [null] });
      for (const b of recon.blockers) reconRows.push({ kind: 'account', label: b.reason, values: [null], indent: 1 });
    }
  } else {
    reconRows.push({ kind: 'note', label: 'No fiscal period exists for this entity/month — nothing to reconcile.', values: [null] });
  }
  const reconModel: StatementModel = {
    ...metaFor('Reconciliation Status'),
    columns: [{ key: 'value', label: 'Value' }],
    rows: reconRows,
  };

  const jeRowsModel: StmtRow[] = jeLines.map((j) => ({
    kind: 'account' as const,
    code: j.entryNumber,
    label: `${j.entryDate}  ${j.memo}`.trim(),
    values: [j.source, j.status, j.amountCents],
  }));
  jeRowsModel.push({ kind: 'total', code: '', label: `${jeLines.length} entries — posted total`, values: ['', '', jePostedTotal] });
  const jeModel: StatementModel = {
    ...metaFor('Journal Entry Listing'),
    columns: [
      { key: 'source', label: 'Source' },
      { key: 'status', label: 'Status' },
      { key: 'amount', label: 'Amount (Dr)', money: true },
    ],
    rows: jeRowsModel,
  };

  const oiRows: StmtRow[] = [];
  if (openItems) {
    oiRows.push({
      kind: 'note',
      label: openItems.readyToHardClose
        ? `Ready to hard-close — every blocking task passes (${openItems.percentComplete}% of all tasks complete).`
        : `NOT ready to hard-close — ${openItems.blockers.length} blocking task(s) outstanding (${openItems.percentComplete}% complete).`,
      values: [null],
    });
    oiRows.push({ kind: 'spacer', label: '', values: [null] });
    for (const t of openItems.tasks) {
      const mark = t.status === 'pass' ? 'PASS' : t.blocking ? 'BLOCKED' : 'WARN';
      oiRows.push({
        kind: t.status === 'pass' ? 'account' : 'subtotal',
        label: `[${mark}] ${t.label} — ${t.driverLabel}${t.blocking ? '' : ' (non-blocking)'}`,
        values: [null],
      });
    }
  } else {
    oiRows.push({ kind: 'note', label: 'No fiscal period — the close-readiness checklist is unavailable.', values: [null] });
  }
  const openItemsModel: StatementModel = {
    ...metaFor('Open Items Summary'),
    columns: [{ key: 'detail', label: 'Detail' }],
    rows: oiRows,
  };

  const buffer = workbookFromModels([trialBalanceModel, reconModel, jeModel, openItemsModel]);
  const filename = buildExportFilename(`close-package-${entityName}-${year}-${String(month).padStart(2, '0')}`, 'xlsx');

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
