/**
 * Loader for R8 Lender reconciliation (statements + floor checks dated in the period).
 */

import { loadSettings } from '@/lib/dealer/service/settings';
import type { StatementKind, StatementMatchStatus, StatementStatus } from '@/lib/dealer/types';
import type { DealerReport } from './catalog';
import { buildLenderRec } from './build-lender-rec';
import { all, allIn, ids, num, str, userNames, type ReportCtx } from './load-shared';

export async function loadLenderRec(d: ReportCtx, start: string, end: string, entityLabel: string): Promise<DealerReport> {
  const [settings, statements] = await Promise.all([
    loadSettings(d),
    all('Lender statements', () =>
      d.db
        .from('lender_statements')
        .select('id, line_id, kind, statement_date, status, prepared_by, prepared_at, approved_by, approved_at, footer_principal_cents')
        .eq('org_id', d.orgId)
        .eq('location_id', d.locationId)
        .in('kind', ['STATEMENT', 'AUDIT'])
        .gte('statement_date', start)
        .lte('statement_date', end),
    ),
  ]);
  const [lines, lineRows] = await Promise.all([
    allIn('Statement lines', ids(statements, 'id'), (chunk) =>
      d.db
        .from('lender_statement_lines')
        .select('id, statement_id, line_number, lender_invoice_number, serial_number, current_cents, variance_cents, match_status, matched_note_id, sau_flag, resolution, resolved_at')
        .eq('org_id', d.orgId)
        .in('statement_id', chunk),
    ),
    allIn('Floor-plan lines', ids(statements, 'line_id'), (chunk) => d.db.from('floor_plan_lines').select('id, name').eq('org_id', d.orgId).in('id', chunk)),
  ]);
  const people = await userNames(d, [...ids(statements, 'prepared_by'), ...ids(statements, 'approved_by')]);
  return buildLenderRec({
    start,
    end,
    entityLabel,
    toleranceCents: settings.statement_tolerance_cents,
    lineNames: new Map(lineRows.map((l) => [l.id as string, String(l.name ?? 'Floor-plan line')])),
    userNames: people,
    statements: statements.map((s) => ({
      id: s.id as string,
      line_id: s.line_id as string,
      kind: s.kind as StatementKind,
      statement_date: String(s.statement_date),
      status: s.status as StatementStatus,
      prepared_by: str(s.prepared_by),
      prepared_at: str(s.prepared_at),
      approved_by: str(s.approved_by),
      approved_at: str(s.approved_at),
      footer_principal_cents: s.footer_principal_cents == null ? null : num(s.footer_principal_cents),
    })),
    lines: lines.map((l) => ({
      id: l.id as string,
      statement_id: l.statement_id as string,
      line_number: l.line_number == null ? null : num(l.line_number),
      lender_invoice_number: str(l.lender_invoice_number),
      serial_number: str(l.serial_number),
      current_cents: l.current_cents == null ? null : num(l.current_cents),
      variance_cents: num(l.variance_cents),
      match_status: l.match_status as StatementMatchStatus,
      matched_note_id: str(l.matched_note_id),
      sau_flag: l.sau_flag === true,
      resolution: str(l.resolution),
      resolved_at: str(l.resolved_at),
    })),
  });
}
