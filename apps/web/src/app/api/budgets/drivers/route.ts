export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { assertWriteScope, serviceWriter } from '@/lib/db/scoped-writer';
import { budgetCtx, budgetError, ensureDraftTarget } from '@/lib/budgets/route-support';
import { assertEditable, writeCellsDetailed } from '@/lib/budgets/service/lines';
import { canSeeDepartment } from '@/lib/budgets/scope';
import { logEvent } from '@/lib/budgets/service/data';
import { z } from 'zod';
import {
  expandDrivers,
  expansionToBudgetCells,
  type BudgetDriver,
} from '@/lib/budget/drivers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─────────────────────────────────────────────────────────────────────────────
// Driver-based budgeting — build a full-year budget from a driver MODEL.
//
// The model is human-owned assumptions (units × price, a cost as % of revenue, a
// fixed amount, a growth curve). The deterministic engine (`lib/budget/drivers`)
// expands it into monthly cents per account. Two verbs:
//   • preview (save=false, default): pure compute → return the expansion. No writes.
//   • commit  (save=true): expand → upsert the cells into the EXISTING `budgets`
//     table (reuse; no new migration) AND log the driver model to `ai_decisions`
//     (feature 'BUDGET_DRIVER_MODEL') for audit + reload (CANON group K3).
//
// STORAGE (reported, not migrated): driver *definitions* are persisted as the
// `proposed_output` JSON of an `ai_decisions` row — no schema change needed. The
// expanded numbers live in `budgets` (the plan-of-record cells). A dedicated
// `budget_driver_models` table would be nicer for versioned round-trip but is
// out of scope this wave; see the report.
// ─────────────────────────────────────────────────────────────────────────────

const ACCOUNT_TYPES = ['REVENUE', 'COGS', 'OPEX', 'OTHER'] as const;

const baseDriver = {
  id: z.string().min(1),
  label: z.string().min(1).max(120),
  accountId: z.string().uuid(),
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

const bodySchema = z.object({
  location_id: z.string().uuid(),
  fiscal_year: z.number().int().min(2020).max(2040),
  department_id: z.string().uuid().nullable().optional(),
  drivers: z.array(driverSchema).min(1).max(500),
  /** false ⇒ preview only (no writes); true ⇒ persist to budgets + decision log. */
  save: z.boolean().optional().default(false),
});

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

  // Deterministic expansion (pure). The response always includes this preview.
  const expansion = expandDrivers(body.drivers as BudgetDriver[]);
  const cells = expansionToBudgetCells(expansion);

  if (!body.save) {
    return NextResponse.json({ preview: true, expansion, cellCount: cells.length });
  }

  if (!orgId) {
    return NextResponse.json({ error: 'No organization on session', code: 'NO_ORG' }, { status: 403 });
  }

  // Commit — mig 189: cells land in the company-year's DRAFT version (current, else a new v1) and
  // publish to public.budgets through the version triggers. A non-draft target is a 409.
  const b = await budgetCtx(ctx, body.location_id);
  if (b instanceof NextResponse) return b;
  let saved = 0;
  let skippedClosed: number[] = [];
  let versionLabel = '';
  try {
    const version = await ensureDraftTarget(b, body.location_id, body.fiscal_year);
    versionLabel = version.label;
    await assertEditable(b, version, body.department_id ?? null);
    // A driver model regenerates the year: closed months keep their budget (reported back).
    ({ changed: saved, skippedClosed } = await writeCellsDetailed(
      b, version, body.department_id ?? null,
      cells.map((c) => ({ accountId: c.account_id, periodNumber: c.period_number, amountCents: c.amount_cents })),
      'DRIVER',
      { closedMonths: 'skip' },
    ));
    await logEvent(b, { locationId: version.locationId, versionId: version.id, kind: 'LINES_GENERATED', meta: { department_id: body.department_id ?? null, source: 'driver-builder', drivers: body.drivers.length, cells: saved } });
  } catch (e) {
    return budgetError(e, 'drivers commit');
  }
  const inserts = cells;

  // Persist the driver MODEL for audit + reload (best-effort; the plan-of-record
  // is the budgets cells above, so a log failure must not fail the save).
  // ai_decisions is SELECT-only for members (migration 172): service-role write, org pinned
  // to the session org; the client (location_id) is asserted in the caller's scope first.
  // Best-effort like before: a log failure (incl. a scope refusal) does not fail the save.
  try {
    await assertWriteScope(supabase, orgId, [body.location_id]);
    await serviceWriter().from('ai_decisions').insert({
      org_id: orgId,
      location_id: body.location_id,
      feature: 'BUDGET_DRIVER_MODEL',
      input_summary: `Driver-based budget · FY${body.fiscal_year} · ${body.drivers.length} drivers · ${expansion.lines.length} accounts`,
      proposed_output: {
        fiscal_year: body.fiscal_year,
        location_id: body.location_id,
        department_id: body.department_id ?? null,
        drivers: body.drivers,
        totalRevenueCents: expansion.totalRevenueCents,
      },
      status: 'APPROVED',
      disposition_by_user: userId,
      disposition_at: new Date().toISOString(),
      created_by_user: userId,
    });
  } catch {
    // best-effort audit/reload log — the budgets cells above are the plan of record
  }

  return NextResponse.json({
    saved: inserts.length,
    changed: saved,
    skippedClosedPeriods: skippedClosed,
    versionLabel,
    published: false,
    accounts: expansion.lines.length,
    totalRevenueCents: expansion.totalRevenueCents,
  });
}

// GET — reload the most recent stored driver model for this scope (for the
// builder to re-open and edit). Returns { model: null } when none exists.
export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('location_id');
  const fiscalYear = parseInt(searchParams.get('fiscal_year') ?? '0', 10);
  const deptRaw = searchParams.get('department_id'); // absent ⇒ company-level
  const departmentId = deptRaw && deptRaw !== 'null' ? deptRaw : null;
  if (!locationId || !UUID.test(locationId) || (departmentId && !UUID.test(departmentId))) {
    return NextResponse.json({ error: 'Pick a company (location_id).', code: 'VALIDATION_ERROR' }, { status: 422 });
  }
  // SECURITY (H6): budget view for the company + the department scope (company-level models are
  // finance's; a department owner reloads only their departments' models).
  const b = await budgetCtx(ctx, locationId);
  if (b instanceof NextResponse) return b;
  if (!canSeeDepartment(b.access, departmentId)) {
    return NextResponse.json({ error: 'That department’s budget isn’t yours to see.', code: 'BUDGET_SCOPE' }, { status: 403 });
  }

  const query = b.reader
    .from('ai_decisions')
    .select('id, proposed_output, created_at, disposition_by_user')
    .eq('feature', 'BUDGET_DRIVER_MODEL')
    .eq('location_id', locationId)
    .order('created_at', { ascending: false })
    .limit(25);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Match the fiscal-year + department scope inside the JSON payload (kept in
  // JS so we don't depend on a jsonb index; the row count is capped at 25).
  const match = (data ?? []).find((row) => {
    const out = row.proposed_output as { fiscal_year?: number; department_id?: string | null } | null;
    if (!out) return false;
    if (fiscalYear && out.fiscal_year !== fiscalYear) return false;
    const rowDept = out.department_id ?? null;
    return rowDept === departmentId;
  });

  return NextResponse.json({
    model: match
      ? { drivers: (match.proposed_output as { drivers?: unknown }).drivers ?? [], savedAt: match.created_at }
      : null,
  });
}
