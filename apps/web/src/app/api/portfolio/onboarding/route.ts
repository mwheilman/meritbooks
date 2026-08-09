export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requireManageUsers } from '@/lib/team/guard';
import { loadEmployeeNames } from '@/lib/portfolio/board';
import {
  loadOnboardingOwners,
  ensurePreparerCapability,
  markOnboardingInProgress,
  ONBOARDING_FUNCTION,
} from '@/lib/team/onboarding-ownership';

/**
 * Per-company ONBOARDING ownership + lifecycle, for the Entities (portfolio) plane.
 *
 * GET  → one row per company: onboarding owner (core.practice_assignments,
 *        function='onboarding') + onboarding status (core.locations.onboarding_status),
 *        plus the assignable roster + an `available` flag. DEGRADE-SAFE: absent table /
 *        column ⇒ everyone unassigned / 'not_started' and the board still renders.
 *
 * PUT  → set/clear a company's onboarding owner and/or move its status. Admin-gated
 *        (requireManageUsers — same gate as Team & Access). RLS-scoped throughout, so
 *        tenant isolation is enforced by the database.
 */

type OnboardingStatus = 'not_started' | 'in_progress' | 'complete';

interface OnboardingRow {
  locationId: string;
  name: string;
  shortCode: string;
  status: OnboardingStatus;
  ownerEmployeeId: string | null;
  ownerName: string | null;
  completedAt: string | null;
}

const STATUSES: readonly OnboardingStatus[] = ['not_started', 'in_progress', 'complete'] as const;
function coerceStatus(v: unknown): OnboardingStatus {
  return typeof v === 'string' && (STATUSES as readonly string[]).includes(v)
    ? (v as OnboardingStatus)
    : 'not_started';
}

export async function GET(_req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  // Companies + their onboarding status. Degrade-safe on the (new) status column.
  let available = true;
  let locations: Array<{ id: string; name: string; short_code: string; onboarding_status?: unknown; onboarding_completed_at?: unknown }> =
    [];
  const withStatus = await supabase
    .schema('core')
    .from('locations')
    .select('id, name, short_code, onboarding_status, onboarding_completed_at, is_active')
    .eq('is_active', true)
    .order('name');
  if (withStatus.error) {
    // Column not migrated yet — fall back to the base columns (status defaults).
    available = false;
    const base = await supabase
      .schema('core')
      .from('locations')
      .select('id, name, short_code, is_active')
      .eq('is_active', true)
      .order('name');
    locations = (base.data ?? []) as typeof locations;
  } else {
    locations = (withStatus.data ?? []) as typeof locations;
  }

  const [owners, empNames] = await Promise.all([
    loadOnboardingOwners(supabase),
    loadEmployeeNames(supabase),
  ]);

  const rows: OnboardingRow[] = locations.map((l) => {
    const ownerEmployeeId = owners.byLocation.get(l.id) ?? null;
    return {
      locationId: l.id,
      name: l.name,
      shortCode: l.short_code,
      status: coerceStatus(l.onboarding_status),
      ownerEmployeeId,
      ownerName: ownerEmployeeId ? empNames.get(ownerEmployeeId) ?? 'Unknown' : null,
      completedAt: typeof l.onboarding_completed_at === 'string' ? l.onboarding_completed_at : null,
    };
  });

  const roster = [...empNames.entries()]
    .map(([employeeId, name]) => ({ employeeId, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({
    available: available && owners.available,
    roster,
    rows,
  });
}

const putSchema = z
  .object({
    locationId: z.string().uuid(),
    // Present (incl. null) ⇒ set/clear the owner. Omitted ⇒ leave owner untouched.
    assigneeEmployeeId: z.string().uuid().nullable().optional(),
    // Present ⇒ move the lifecycle. Omitted ⇒ leave status untouched.
    status: z.enum(['not_started', 'in_progress', 'complete']).optional(),
  })
  .refine((v) => v.assigneeEmployeeId !== undefined || v.status !== undefined, {
    message: 'Provide assigneeEmployeeId and/or status',
  });

export async function PUT(req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  // Admin-gated — assigning who owns a client's onboarding is a management action.
  const grant = await requireManageUsers(supabase, userId, orgId);
  if (grant instanceof NextResponse) return grant;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = putSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }
  const { locationId, assigneeEmployeeId, status } = parsed.data;

  // 1. Owner set/clear.
  if (assigneeEmployeeId !== undefined) {
    if (assigneeEmployeeId === null) {
      const { error } = await supabase
        .schema('core')
        .from('practice_assignments')
        .delete()
        .eq('org_id', orgId!)
        .eq('location_id', locationId)
        .eq('function', ONBOARDING_FUNCTION);
      if (error) {
        return NextResponse.json(
          { applied: false, reason: 'Onboarding ownership unavailable (apply the migration first).' },
          { status: 200 },
        );
      }
    } else {
      const { error } = await supabase
        .schema('core')
        .from('practice_assignments')
        .upsert(
          {
            org_id: orgId!,
            location_id: locationId,
            function: ONBOARDING_FUNCTION,
            assignee_employee_id: assigneeEmployeeId,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'org_id,location_id,function' },
        );
      if (error) {
        return NextResponse.json(
          { applied: false, reason: 'Onboarding ownership unavailable (apply the migration first).' },
          { status: 200 },
        );
      }
      await ensurePreparerCapability(supabase, orgId!, assigneeEmployeeId);
      // Assigning an owner nudges a not_started company into in_progress (unless the
      // caller is explicitly setting a status below).
      if (status === undefined) await markOnboardingInProgress(supabase, orgId!, [locationId]);
    }
  }

  // 2. Status move (independent of owner).
  if (status !== undefined) {
    const patch: Record<string, unknown> = {
      onboarding_status: status,
      onboarding_completed_at: status === 'complete' ? new Date().toISOString() : null,
    };
    const { error } = await supabase
      .schema('core')
      .from('locations')
      .update(patch)
      .eq('org_id', orgId!)
      .eq('id', locationId);
    if (error) {
      return NextResponse.json(
        { applied: false, reason: 'Onboarding status unavailable (apply the migration first).' },
        { status: 200 },
      );
    }
  }

  return NextResponse.json({ applied: true });
}
