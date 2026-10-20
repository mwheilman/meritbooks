export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { BatchDetail, type BatchStatementRow } from '../_components/batch-detail';
import type { BatchRow } from '../_components/imports-screen';

/**
 * One import batch: what came in, what was refused and why, the rows it created, and
 * Undo. The batch + its statements are read here through the caller's RLS client (tenant
 * + client scope enforce visibility); the created units / notes / deals / claims load
 * client-side from the D1 list routes filtered by import_batch_id.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ImportBatchPage({ params }: { params: { id: string } }) {
  if (!UUID.test(params.id)) notFound();
  const db = await createServerSupabase();
  const { data: batch, error } = await db.from('dealer_import_batches').select('*').eq('id', params.id).maybeSingle();
  if (error) throw new Error(`Import lookup failed: ${error.message}`);
  if (!batch) notFound();

  const [lender, oem] = await Promise.all([
    db.from('lender_statements').select('id, kind, statement_date, status, line_id, footer_principal_cents').eq('import_batch_id', params.id).order('statement_date'),
    db.from('oem_statements').select('id, statement_date, status, oem_vendor_id, footer_total_cents').eq('import_batch_id', params.id).order('statement_date'),
  ]);
  const statements: BatchStatementRow[] = [
    ...((lender.data ?? []) as Array<{ id: string; kind: string; statement_date: string; status: string; footer_principal_cents: number | string | null }>).map((s) => ({
      id: s.id, type: 'lender' as const, kind: s.kind, statementDate: s.statement_date, status: s.status, totalCents: s.footer_principal_cents == null ? null : Number(s.footer_principal_cents),
    })),
    ...((oem.data ?? []) as Array<{ id: string; statement_date: string; status: string; footer_total_cents: number | string | null }>).map((s) => ({
      id: s.id, type: 'oem' as const, kind: null, statementDate: s.statement_date, status: s.status, totalCents: s.footer_total_cents == null ? null : Number(s.footer_total_cents),
    })),
  ];

  const b = batch as Record<string, unknown>;
  const row: BatchRow = {
    ...(b as unknown as BatchRow),
    row_count: Number(b.row_count ?? 0),
    accepted_count: Number(b.accepted_count ?? 0),
    rejected_count: Number(b.rejected_count ?? 0),
  };
  return <BatchDetail batch={row} statements={statements} statementsError={lender.error?.message ?? oem.error?.message ?? null} />;
}
