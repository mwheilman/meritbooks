export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import {
  AUTONOMY_FEATURES,
  AUTONOMY_FEATURE_MAP,
} from '@/lib/autonomy/catalog';
import { DEFAULT_MODE, type AutonomyMode } from '@/lib/autonomy/disposition';
import { updateAutonomySchema, killSwitchSchema } from '@/lib/autonomy/validation';

/**
 * Autonomy & Kill-Switch Control Plane API (M10) — the supervision surface that
 * governs EVERY AI capability. Canon §3: auto-post is OFF by default; autonomy is a
 * per-tenant, per-task dial; every change is written to the Decision Log (core.action_log).
 *
 *   GET  — current per-feature dials (merged with the catalog defaults) + kill-switch state.
 *   PUT  — change one feature's mode / materiality cap.
 *   POST — engage / disengage the global kill switch.
 *
 * RBAC: reads gate on settings_system:view; mutations gate on settings_system:edit —
 * the strictest existing admin permission (only company_admin holds settings_system:edit;
 * cfo may view). There is no dedicated "govern AI" permission, so this reuses the
 * system/integration-settings authority, which is the correct blast radius for
 * turning autonomous action on/off. All reads/writes run through the RLS-scoped
 * client, so the database enforces org isolation; the route never filters org_id by hand.
 */

interface SettingRow {
  feature: string;
  mode: string | null;
  materiality_limit_cents: number | string | null;
  updated_by: string | null;
  updated_at: string | null;
}

interface KillSwitchRow {
  engaged: boolean | null;
  engaged_by: string | null;
  engaged_at: string | null;
  reason: string | null;
}

function normMode(raw: string | null | undefined): AutonomyMode {
  if (raw === 'OFF' || raw === 'PROPOSE' || raw === 'AUTO_UNDER_LIMIT') return raw;
  return DEFAULT_MODE;
}

// ── GET: dials + kill switch ────────────────────────────────────────────────
export async function GET(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) {
    return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });
  }

  const guard = await requirePermission(userId, 'settings_system', 'view');
  if (!guard.ok) return guard.response;

  // Degrade safe: if the tables do not yet exist (pre-migration 075) the reads
  // error — fall back to catalog defaults + a disengaged kill switch so the screen
  // still renders and reflects the most-conservative (PROPOSE) posture.
  const settingsByFeature = new Map<string, SettingRow>();
  try {
    const { data } = await supabase
      .from('autonomy_settings')
      .select('feature, mode, materiality_limit_cents, updated_by, updated_at')
      .eq('org_id', orgId);
    for (const row of (data ?? []) as SettingRow[]) settingsByFeature.set(row.feature, row);
  } catch {
    /* tables not present yet — use defaults */
  }

  let kill: KillSwitchRow | null = null;
  try {
    const { data } = await supabase
      .from('autonomy_kill_switch')
      .select('engaged, engaged_by, engaged_at, reason')
      .eq('org_id', orgId)
      .maybeSingle();
    kill = (data as KillSwitchRow | null) ?? null;
  } catch {
    kill = null;
  }

  const features = AUTONOMY_FEATURES.map((def) => {
    const row = settingsByFeature.get(def.feature);
    return {
      feature: def.feature,
      label: def.label,
      description: def.description,
      category: def.category,
      mode: row ? normMode(row.mode) : def.defaultMode,
      materialityLimitCents:
        row && row.materiality_limit_cents != null ? Number(row.materiality_limit_cents) : null,
      isDefault: !row,
      updatedBy: row?.updated_by ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  });

  return NextResponse.json({
    data: {
      killSwitch: {
        engaged: kill?.engaged === true,
        engagedBy: kill?.engaged_by ?? null,
        engagedAt: kill?.engaged_at ?? null,
        reason: kill?.reason ?? null,
      },
      features,
    },
  });
}

// ── PUT: change one feature's dial ──────────────────────────────────────────
export async function PUT(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) {
    return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });
  }

  const guard = await requirePermission(userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = updateAutonomySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const { feature, mode, materialityLimitCents } = parsed.data;

  // AUTO_UNDER_LIMIT without a cap can never auto-apply (disposition routes it to
  // review); reject it so the admin doesn't think they've enabled autonomy when
  // they haven't. OFF / PROPOSE ignore the cap.
  if (mode === 'AUTO_UNDER_LIMIT' && (materialityLimitCents == null || materialityLimitCents <= 0)) {
    return NextResponse.json(
      {
        error: 'Auto-under-limit requires a positive materiality cap (in cents).',
        code: 'CAP_REQUIRED',
      },
      { status: 422 },
    );
  }

  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from('autonomy_settings')
    .upsert(
      {
        org_id: orgId,
        feature,
        mode,
        materiality_limit_cents: mode === 'AUTO_UNDER_LIMIT' ? materialityLimitCents : null,
        updated_by: userId,
        updated_at: nowIso,
      },
      { onConflict: 'org_id,feature' },
    );
  if (error) {
    return NextResponse.json(
      { error: error.message, code: 'AUTONOMY_WRITE_FAILED' },
      { status: 500 },
    );
  }

  const label = AUTONOMY_FEATURE_MAP[feature]?.label ?? feature;
  await logHumanAction(supabase, userId, orgId, {
    action: 'autonomy.dial.change',
    subjectTable: 'autonomy_settings',
    subjectId: feature,
    summary: `Set autonomy dial for ${label} → ${mode}${
      mode === 'AUTO_UNDER_LIMIT' ? ` (cap ${materialityLimitCents}¢)` : ''
    }`,
    metadata: { feature, mode, materiality_limit_cents: materialityLimitCents },
  });

  return NextResponse.json({ data: { feature, mode, materialityLimitCents } });
}

// ── POST: engage / disengage the global kill switch ─────────────────────────
export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) {
    return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });
  }

  const guard = await requirePermission(userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = killSwitchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const { engaged, reason } = parsed.data;
  const nowIso = new Date().toISOString();

  const { error } = await supabase.from('autonomy_kill_switch').upsert(
    {
      org_id: orgId,
      engaged,
      engaged_by: userId,
      engaged_at: engaged ? nowIso : null,
      reason: engaged ? (reason ?? null) : null,
      updated_at: nowIso,
    },
    { onConflict: 'org_id' },
  );
  if (error) {
    return NextResponse.json(
      { error: error.message, code: 'KILL_SWITCH_WRITE_FAILED' },
      { status: 500 },
    );
  }

  await logHumanAction(supabase, userId, orgId, {
    action: engaged ? 'autonomy.killswitch.engage' : 'autonomy.killswitch.disengage',
    subjectTable: 'autonomy_kill_switch',
    subjectId: orgId,
    summary: engaged
      ? `Engaged the global autonomy kill switch${reason ? ` — ${reason}` : ''}`
      : 'Disengaged the global autonomy kill switch',
    metadata: { engaged, reason: reason ?? null },
  });

  return NextResponse.json({ data: { engaged } });
}
