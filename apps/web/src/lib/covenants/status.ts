/**
 * Covenant status builder — the one place that stitches the deterministic pieces
 * together for a single covenant: resolve ledger inputs → evaluate current
 * value/headroom/band → project the breach date off the cash forecast. Shared by
 * the list route, the compute/alert route, and the certificate drafter so all
 * three read identical numbers. No model, no side effects.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildForecastSeries,
  evaluateCovenant,
  projectBreach,
  type CovenantType,
  type CovenantDirection,
  type CovenantEvaluation,
  type BreachProjection,
} from './compute';
import {
  resolveCovenantInputs,
  projectCashDeltas,
  type CovenantComponents,
  type CovenantMeasurementConfig,
} from './ledger';

export interface CovenantRow {
  id: string;
  location_id: string | null;
  loan_name: string;
  facility: string | null;
  lender_name: string | null;
  covenant_type: CovenantType;
  threshold: number | string;
  direction: CovenantDirection;
  test_frequency: string;
  warn_headroom_pct: number | string;
  measurement: CovenantMeasurementConfig | null;
  status: string;
  effective_date: string | null;
  maturity_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CovenantStatus {
  covenant: CovenantRow;
  periodEnd: string;
  evaluation: CovenantEvaluation;
  components: CovenantComponents;
  breach: BreachProjection;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Compute the full status for one covenant. `includeForecast` controls whether the
 * (heavier) cash-delta projection runs — the certificate needs it; a bulk list can
 * skip it per-covenant if desired (here it is always on, but tolerant of failure).
 */
export async function buildCovenantStatus(
  supabase: SupabaseClient,
  covenant: CovenantRow,
  periodEnd: string = todayIso(),
): Promise<CovenantStatus> {
  const threshold = Number(covenant.threshold);
  const warnPct = Number(covenant.warn_headroom_pct);
  const type = covenant.covenant_type;
  const direction = covenant.direction;

  const { inputs, components } = await resolveCovenantInputs(
    supabase,
    { location_id: covenant.location_id, measurement: covenant.measurement },
    periodEnd,
  );

  const evaluation = evaluateCovenant(type, inputs, threshold, direction, warnPct);

  // Project the breach off the existing cash forecast. Tolerate a forecast failure
  // (e.g. no bank/AR/AP data) — the current test still stands.
  let breach: BreachProjection = { breachDate: null, breachIndex: -1, crossingDate: null, breachedAtStart: false };
  try {
    const deltas = await projectCashDeltas(supabase, covenant.location_id);
    if (deltas.length > 0) {
      const series = buildForecastSeries(type, inputs, threshold, direction, deltas);
      breach = projectBreach(series, threshold, direction);
    }
  } catch {
    // leave breach as the no-projection default
  }

  return { covenant, periodEnd, evaluation, components, breach };
}
