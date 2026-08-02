export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { z } from 'zod';
import {
  buildThreeCase,
  type ScenarioDefinition,
  type ScenarioOverride,
} from '@/lib/budget/scenarios';
import type { BudgetDriver } from '@/lib/budget/drivers';

// ─────────────────────────────────────────────────────────────────────────────
// FP&A SCENARIO / WHAT-IF — best/base/worst on a driver-based budget.
//
// A scenario is a NAMED override set (revenue growth ±%, cost change ±%,
// headcount ±N) layered on an existing driver model. The deterministic engine
// (`lib/budget/scenarios`, which reuses `lib/budget/drivers`) computes each case
// and the variance vs base. Verbs:
//   • POST (save=false, default): COMPARE — compute best/base/worst for the given
//     definition and return summaries. Pure, no writes.
//   • POST (save=true): CREATE — compute AND persist the definition to
//     `ai_decisions` (feature 'BUDGET_SCENARIO'); no schema change.
//   • GET: LIST — the saved scenarios for a scope, each recomputed deterministically
//     so the list shows headline best/base/worst numbers.
//
// STORAGE (reported, not migrated): the scenario definition (baseDrivers, the
// three case override lists, beginning cash) is the `proposed_output` JSON of an
// `ai_decisions` row — reusing the exact pattern the driver-model save uses. A
// dedicated `budget_scenarios` table would give versioned round-trip but is out
// of scope this wave (no reserved-spine migration). See the wave report.
//
// RLS: runs AS THE USER via requireAuthedContext → org_isolation enforces tenant.
// ─────────────────────────────────────────────────────────────────────────────

const ACCOUNT_TYPES = ['REVENUE', 'COGS', 'OPEX', 'OTHER'] as const;

const baseDriver = {
  id: z.string().min(1),
  label: z.string().min(1).max(120),
  accountId: z.string().min(1),
  accountType: z.enum(ACCOUNT_TYPES),
};

const driverSchema = z.discriminatedUnion('driverType', [
  z.object({
    ...baseDriver,
    driverType: z.literal('volume_x_rate'),
    unitRateCents: z.number().int(),
    volumeByMonth: z.array(z.number()).max(12),
  }),
  z.object({
    ...baseDriver,
    driverType: z.literal('percent_of_revenue'),
    percentBps: z.number().int().min(0).max(1_000_000),
  }),
  z.object({
    ...baseDriver,
    driverType: z.literal('fixed'),
    annualAmountCents: z.number().int(),
    weights: z.array(z.number()).length(12).optional(),
  }),
  z.object({
    ...baseDriver,
    driverType: z.literal('growth_rate'),
    baseMonthlyCents: z.number().int(),
    monthlyGrowthBps: z.number().int().min(-9999).max(1_000_000),
  }),
]);

const overrideSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('revenue_growth'),
    deltaBps: z.number().int().min(-1_000_000).max(1_000_000),
  }),
  z.object({
    kind: z.literal('cost_change'),
    deltaBps: z.number().int().min(-1_000_000).max(1_000_000),
    costTypes: z.array(z.enum(ACCOUNT_TYPES)).optional(),
  }),
  z.object({
    kind: z.literal('headcount'),
    deltaHeads: z.number().int().min(-10_000).max(10_000),
    monthlyCostPerHeadCents: z.number().int().min(0),
    accountId: z.string().min(1),
  }),
]);

const casesSchema = z.object({
  best: z.array(overrideSchema).max(50),
  base: z.array(overrideSchema).max(50),
  worst: z.array(overrideSchema).max(50),
});

const bodySchema = z.object({
  location_id: z.string().uuid(),
  fiscal_year: z.number().int().min(2020).max(2040),
  department_id: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(120),
  baseDrivers: z.array(driverSchema).min(1).max(500),
  cases: casesSchema,
  beginningCashCents: z.number().int().default(0),
  /** false ⇒ compare-only (no writes); true ⇒ persist to the decision log. */
  save: z.boolean().optional().default(false),
});

function toDefinition(body: z.infer<typeof bodySchema>): ScenarioDefinition {
  return {
    name: body.name,
    baseDrivers: body.baseDrivers as BudgetDriver[],
    cases: body.cases as {
      best: ScenarioOverride[];
      base: ScenarioOverride[];
      worst: ScenarioOverride[];
    },
    beginningCashCents: body.beginningCashCents,
  };
}

/** Strip the (large) per-case expansion — the UI only needs the summaries. */
function toWireResult(def: ScenarioDefinition) {
  const r = buildThreeCase(def);
  return {
    best: { overrides: r.best.overrides, summary: r.best.summary },
    base: { overrides: r.base.overrides, summary: r.base.summary },
    worst: { overrides: r.worst.overrides, summary: r.worst.summary },
    varianceVsBase: r.varianceVsBase,
  };
}

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.issues },
      { status: 422 }
    );
  }
  const body = parsed.data;
  const def = toDefinition(body);
  const result = toWireResult(def);

  if (!body.save) {
    return NextResponse.json({ compare: true, name: body.name, result });
  }

  if (!orgId) {
    return NextResponse.json({ error: 'No organization on session', code: 'NO_ORG' }, { status: 403 });
  }

  const { data: inserted, error } = await supabase
    .from('ai_decisions')
    .insert({
      org_id: orgId,
      location_id: body.location_id,
      feature: 'BUDGET_SCENARIO',
      input_summary: `Scenario "${body.name}" · FY${body.fiscal_year} · ${body.baseDrivers.length} drivers`,
      proposed_output: {
        name: body.name,
        fiscal_year: body.fiscal_year,
        location_id: body.location_id,
        department_id: body.department_id ?? null,
        baseDrivers: body.baseDrivers,
        cases: body.cases,
        beginningCashCents: body.beginningCashCents,
      },
      status: 'APPROVED',
      disposition_by_user: userId,
      disposition_at: new Date().toISOString(),
      created_by_user: userId,
    })
    .select('id, created_at')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    saved: true,
    id: inserted?.id ?? null,
    savedAt: inserted?.created_at ?? null,
    name: body.name,
    result,
  });
}

// GET — list saved scenarios for a scope, each recomputed deterministically.
export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase } = ctx;

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('location_id');
  const fiscalYear = parseInt(searchParams.get('fiscal_year') ?? '0', 10);
  const departmentId = searchParams.get('department_id'); // absent ⇒ company-level

  let query = supabase
    .from('ai_decisions')
    .select('id, proposed_output, created_at, disposition_by_user')
    .eq('feature', 'BUDGET_SCENARIO')
    .order('created_at', { ascending: false })
    .limit(50);
  if (locationId) query = query.eq('location_id', locationId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const scenarios = (data ?? [])
    .filter((row) => {
      const out = row.proposed_output as { fiscal_year?: number; department_id?: string | null } | null;
      if (!out) return false;
      if (fiscalYear && out.fiscal_year !== fiscalYear) return false;
      const rowDept = out.department_id ?? null;
      return rowDept === (departmentId ?? null);
    })
    .map((row) => {
      const out = row.proposed_output as {
        name?: string;
        baseDrivers?: BudgetDriver[];
        cases?: ScenarioDefinition['cases'];
        beginningCashCents?: number;
      };
      let result = null;
      try {
        if (out.baseDrivers && out.cases) {
          result = toWireResult({
            name: out.name ?? 'Scenario',
            baseDrivers: out.baseDrivers,
            cases: out.cases,
            beginningCashCents: out.beginningCashCents ?? 0,
          });
        }
      } catch {
        result = null; // a malformed stored payload must not fail the list
      }
      return {
        id: row.id,
        name: out.name ?? 'Scenario',
        savedAt: row.created_at,
        definition: {
          baseDrivers: out.baseDrivers ?? [],
          cases: out.cases ?? { best: [], base: [], worst: [] },
          beginningCashCents: out.beginningCashCents ?? 0,
        },
        result,
      };
    });

  return NextResponse.json({ scenarios });
}
