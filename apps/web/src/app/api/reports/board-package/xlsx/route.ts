export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // Buffer + zlib (xlsx zip assembly) — not edge

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { boardPackageSchema, type BoardPackage } from '@/lib/reports/board-package';
import {
  buildIncomeStatement,
  buildBalanceSheet,
  buildCashFlow,
  type ExportMeta,
} from '@/lib/reports/export/build-model';
import { workbookFromModels } from '@/lib/reports/export/xlsx';
import { buildExportFilename, type StatementModel, type StmtRow } from '@/lib/reports/export/statement-model';

/**
 * POST /api/reports/board-package/xlsx — render an assembled Board Package to a
 * multi-worksheet .xlsx (KPIs, Statement of Operations, Balance Sheet, Cash Flows,
 * A/R & A/P aging, Notes). The Excel sibling of /board-package/pdf: the client POSTs
 * the SAME BoardPackage it got from GET and is previewing, so the workbook ties out
 * to the screen. No GL is re-queried here, so there is nothing tenant-sensitive to
 * leak — the route only formats and needs an authenticated user.
 */
function meta(pkg: BoardPackage, reportLabel: string): ExportMeta {
  return {
    reportLabel,
    entityLabel: pkg.meta.entityLabel,
    periodLabel: pkg.meta.periodLabel,
    basisLabel: pkg.meta.basisLabel || undefined,
    accent: pkg.meta.accent,
  };
}

function agingModel(
  pkg: BoardPackage,
  buckets: Record<string, { count: number; totalCents: number }>,
  totalOutstanding: number,
  title: string,
): StatementModel {
  const order = ['CURRENT', '1-30', '31-60', '61-90', '90+'];
  const rows: StmtRow[] = order.map((b) => ({
    kind: 'account' as const,
    label: b === 'CURRENT' ? 'Current' : `${b} days`,
    values: [String(buckets[b]?.count ?? 0), buckets[b]?.totalCents ?? 0],
  }));
  rows.push({ kind: 'total', label: 'Total Outstanding', values: ['', totalOutstanding] });
  return {
    title,
    entityLabel: pkg.meta.entityLabel,
    periodLabel: `As of ${pkg.meta.asOfDate}`,
    generatedAt: pkg.meta.generatedAt,
    accent: pkg.meta.accent,
    columns: [
      { key: 'items', label: 'Open Items' },
      { key: 'amount', label: 'Amount', money: true },
    ],
    rows,
  };
}

function kpiModel(pkg: BoardPackage): StatementModel {
  const rows: StmtRow[] = pkg.kpis.cards.map((c) => ({
    kind: 'account' as const,
    label: c.label,
    values: [c.valueText, c.deltaPct != null ? `${c.deltaPct > 0 ? '+' : ''}${c.deltaPct}% vs prior` : (c.hint ?? '')],
  }));
  return {
    title: 'Key Performance Indicators',
    entityLabel: pkg.meta.entityLabel,
    periodLabel: pkg.meta.periodLabel,
    basisLabel: pkg.meta.basisLabel || undefined,
    generatedAt: pkg.meta.generatedAt,
    accent: pkg.meta.accent,
    columns: [
      { key: 'value', label: 'Value' },
      { key: 'context', label: 'Context' },
    ],
    rows,
  };
}

function notesModel(pkg: BoardPackage): StatementModel {
  const rows: StmtRow[] = [];
  for (const n of pkg.notes.notes) {
    rows.push({ kind: 'section', label: n.title, values: [null] });
    for (const p of n.body) rows.push({ kind: 'account', label: p, values: [null], indent: 1 });
    if (n.table) {
      rows.push({ kind: 'subtotal', label: n.table.columns.join('  |  '), values: [null] });
      for (const r of n.table.rows) rows.push({ kind: 'account', label: r.map(String).join('  |  '), values: [null], indent: 1 });
    }
    rows.push({ kind: 'spacer', label: '', values: [null] });
  }
  return {
    title: 'Notes to Financial Statements',
    entityLabel: pkg.meta.entityLabel,
    periodLabel: pkg.meta.periodLabel,
    generatedAt: pkg.meta.generatedAt,
    accent: pkg.meta.accent,
    columns: [{ key: 'detail', label: 'Detail' }],
    rows,
  };
}

export async function POST(req: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, { status: 400 });
  }

  const parsed = boardPackageSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid board package', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }
  const pkg = parsed.data;

  const models: StatementModel[] = [
    kpiModel(pkg),
    buildIncomeStatement(pkg.statements.incomeStatement, meta(pkg, 'Statement of Operations')),
    buildBalanceSheet(pkg.statements.balanceSheet, meta(pkg, 'Balance Sheet')),
    buildCashFlow(pkg.statements.cashFlow, meta(pkg, 'Statement of Cash Flows')),
    agingModel(pkg, pkg.statements.arAging.buckets, pkg.statements.arAging.totalOutstanding, 'Accounts Receivable Aging'),
    agingModel(pkg, pkg.statements.apAging.buckets, pkg.statements.apAging.totalOutstanding, 'Accounts Payable Aging'),
    notesModel(pkg),
  ];

  const buffer = workbookFromModels(models);
  const filename = buildExportFilename(`board-package-${pkg.meta.entityLabel}`, 'xlsx');

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
