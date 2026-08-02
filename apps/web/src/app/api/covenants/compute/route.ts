export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { buildCovenantStatus, type CovenantRow, type CovenantStatus } from '@/lib/covenants/status';
import { formatMoney } from '@meritbooks/shared';

/**
 * POST /api/covenants/compute — run the covenant tests and record the results.
 *
 * For every ACTIVE covenant this:
 *   1. computes the current value / headroom / band + projected breach date
 *      (deterministically, from the ledger — the model is NOT involved), and
 *      appends a `covenant_measurements` snapshot (the trend + audit trail);
 *   2. when a covenant is nearing (WARN) or in breach (BREACH), or the forecast
 *      projects a breach inside the horizon, upserts a PROPOSED row into
 *      `ai_decisions` with feature 'COVENANT_DRIFT' so it surfaces on /exceptions.
 *
 * A stable dedup_key (`covenant:<id>`) means a re-run UPDATES the open exception
 * rather than duplicating it (migration 070 partial unique index is the DB
 * guarantor). Covenants that clear (band PASS, no projected breach) EXPIRE any
 * open alert. RLS-scoped; degrade-safe (no covenants → nothing happens).
 */

const FEATURE = 'COVENANT_DRIFT';

const SELECT =
  'id, location_id, loan_name, facility, lender_name, covenant_type, threshold, direction, ' +
  'test_frequency, warn_headroom_pct, measurement, status, effective_date, maturity_date, notes, ' +
  'created_at, updated_at';

function unitOf(s: CovenantStatus): 'RATIO' | 'CURRENCY' {
  return s.evaluation.unit;
}

function valueLabel(s: CovenantStatus): string {
  const v = s.evaluation.value;
  if (v === null) return 'n/a';
  return unitOf(s) === 'CURRENCY' ? formatMoney(Math.round(v * 100)) : `${v.toFixed(2)}x`;
}

function thresholdLabel(s: CovenantStatus): string {
  const t = s.evaluation.threshold;
  return unitOf(s) === 'CURRENCY' ? formatMoney(Math.round(t * 100)) : `${t.toFixed(2)}x`;
}

/** Advisory autonomy disposition — covenant drift is always a human ESCALATE/REVIEW. */
function dispositionFor(band: string): 'ESCALATE' | 'REVIEW' {
  return band === 'BREACH' ? 'ESCALATE' : 'REVIEW';
}

export async function POST(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const { data, error } = await supabase
    .from('loan_covenants')
    .select(SELECT)
    .eq('status', 'ACTIVE');
  if (error) {
    return NextResponse.json({ error: 'Failed to load covenants', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
  const rows = (data ?? []) as CovenantRow[];

  let measured = 0;
  let alerted = 0;
  let cleared = 0;

  for (const row of rows) {
    let status: CovenantStatus;
    try {
      status = await buildCovenantStatus(supabase, row);
    } catch (e) {
      console.error('[covenants/compute] status failed', row.id, e instanceof Error ? e.message : e);
      continue;
    }
    const { evaluation, components, breach } = status;

    // 1. Snapshot (trend + audit). Non-fatal on failure.
    try {
      await supabase.from('covenant_measurements').insert({
        org_id: orgId,
        covenant_id: row.id,
        period_end: status.periodEnd,
        source: 'ACTUAL',
        value: evaluation.value,
        numerator_cents: evaluation.numeratorCents,
        denominator_cents: evaluation.denominatorCents,
        threshold: evaluation.threshold,
        direction: evaluation.direction,
        unit: evaluation.unit,
        headroom_pct: evaluation.headroomPct,
        passed: evaluation.passed,
        band: evaluation.band,
        projected_breach_date: breach.crossingDate ?? breach.breachDate,
        components: components as unknown as Record<string, unknown>,
      });
      measured += 1;
    } catch (e) {
      console.error('[covenants/compute] snapshot failed', row.id, e instanceof Error ? e.message : e);
    }

    const projectedBreach = breach.crossingDate ?? breach.breachDate;
    const needsAlert =
      evaluation.band === 'BREACH' || evaluation.band === 'WARN' || projectedBreach !== null;
    const dedupKey = `covenant:${row.id}`;

    if (needsAlert) {
      const headroomTxt =
        evaluation.headroomPct === null ? 'n/a' : `${(evaluation.headroomPct * 100).toFixed(1)}%`;
      const summary =
        `${row.loan_name} — ${row.covenant_type} ${evaluation.direction === 'MIN' ? '≥' : '≤'} ` +
        `${thresholdLabel(status)}: now ${valueLabel(status)} (${evaluation.band}, headroom ${headroomTxt})` +
        (projectedBreach ? ` — projected breach ${projectedBreach}` : '');

      const proposed = {
        dedup_key: dedupKey,
        disposition: dispositionFor(evaluation.band),
        covenant_id: row.id,
        covenant_type: row.covenant_type,
        band: evaluation.band,
        value: evaluation.value,
        threshold: evaluation.threshold,
        unit: evaluation.unit,
        headroom_pct: evaluation.headroomPct,
        projected_breach_date: projectedBreach,
        period_end: status.periodEnd,
      };

      try {
        // Upsert the single open alert for this covenant.
        const { data: existing } = await supabase
          .from('ai_decisions')
          .select('id')
          .eq('feature', FEATURE)
          .eq('status', 'PROPOSED')
          .contains('proposed_output', { dedup_key: dedupKey })
          .maybeSingle();

        if (existing?.id) {
          await supabase
            .from('ai_decisions')
            .update({ input_summary: summary.slice(0, 2000), proposed_output: proposed })
            .eq('id', existing.id);
        } else {
          await supabase.from('ai_decisions').insert({
            org_id: orgId,
            location_id: row.location_id,
            feature: FEATURE,
            input_summary: summary.slice(0, 2000),
            proposed_output: proposed,
            reasoning:
              'Deterministic covenant test on actuals + cash-forecast trajectory. ' +
              'Figures computed in code from the ledger; the model is not involved in the ratio.',
            status: 'PROPOSED',
            created_by_user: userId,
          });
        }
        alerted += 1;
      } catch (e) {
        // Unique-index race (another concurrent compute) is expected + harmless.
        console.error('[covenants/compute] alert upsert failed', row.id, e instanceof Error ? e.message : e);
      }
    } else {
      // Cleared → expire any open alert for this covenant.
      try {
        const { data: open } = await supabase
          .from('ai_decisions')
          .select('id')
          .eq('feature', FEATURE)
          .eq('status', 'PROPOSED')
          .contains('proposed_output', { dedup_key: dedupKey })
          .maybeSingle();
        if (open?.id) {
          await supabase
            .from('ai_decisions')
            .update({ status: 'EXPIRED', disposition_at: new Date().toISOString(), disposition_note: 'Covenant back in compliance' })
            .eq('id', open.id);
          cleared += 1;
        }
      } catch {
        // non-fatal
      }
    }
  }

  return NextResponse.json({ ok: true, tested: rows.length, measured, alerted, cleared });
}
