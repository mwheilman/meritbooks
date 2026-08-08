export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requireManageUsers } from '@/lib/team/guard';
import { createInvitationSchema } from '@/lib/validations/invitations';
import { createAdminSupabase } from '@/lib/supabase/server';
import { ROLE_DEFINITIONS } from '@/lib/rbac/permissions';
import { logHumanAction } from '@/lib/trust/action-log';
import { resolveEmailProvider, resolveFromAddress, EmailSendError } from '@/lib/email/provider';
import {
  INVITATIONS_SCHEMA,
  INVITATIONS_TABLE,
  INVITE_TTL_DAYS,
  isMissingInvitationsTable,
  isAllCompaniesScope,
  generateInviteToken,
  inviteAcceptUrl,
  buildInvitationEmail,
  mapPending,
  type InvitationRow,
} from '@/lib/team/invitations';
import {
  isAdminLevelRole,
  isMissingScopeColumn,
  normalizeAdminScopeForStorage,
} from '@/lib/team/admin-scope';

const SELECT_COLS =
  'id, org_id, email, role, first_name, last_name, location_ids, token, status, invited_by_clerk, expires_at, accepted_at, revoked_at, created_at';
/** Same, plus the delegated-admin capability column (used when it exists). */
const SELECT_COLS_WITH_SCOPE = `${SELECT_COLS}, admin_scope`;

/**
 * GET /api/team/invitations
 * Admin-only list of PENDING invitations for the org. Degrade-safe: if the backing
 * table isn't migrated yet, returns { data: [], available: false } (200) so the UI
 * can show "unavailable until migration" instead of an error.
 */
export async function GET(_req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  const grant = await requireManageUsers(supabase, userId, orgId);
  if (grant instanceof NextResponse) return grant;

  const admin = createAdminSupabase();
  // Prefer the scope-bearing select; degrade to the base columns if the admin_scope
  // column isn't migrated yet (mapPending then reports adminScope: null = full admin).
  const listPending = (cols: string) =>
    admin
      .schema(INVITATIONS_SCHEMA)
      .from(INVITATIONS_TABLE)
      .select(cols)
      .eq('org_id', orgId!)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

  let rows: InvitationRow[] = [];
  let error: { code?: string; message?: string } | null = null;
  const withScope = await listPending(SELECT_COLS_WITH_SCOPE);
  if (withScope.error && isMissingScopeColumn(withScope.error)) {
    const base = await listPending(SELECT_COLS);
    error = base.error;
    rows = (base.data ?? []) as unknown as InvitationRow[];
  } else {
    error = withScope.error;
    rows = (withScope.data ?? []) as unknown as InvitationRow[];
  }

  if (error) {
    if (isMissingInvitationsTable(error)) {
      return NextResponse.json({ data: [], available: false });
    }
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  return NextResponse.json({
    data: rows.map(mapPending),
    available: true,
  });
}

/**
 * POST /api/team/invitations
 * Create a pending invitation for { email, role, companyIds } and email a sign-up
 * link. The seat is materialized on the invitee's first login (lib/identity/
 * claim-invitation.ts). Email delivery is best-effort: the invite is created even if
 * email isn't configured (the returned link can be shared manually), and the response
 * reports emailSent honestly — never a silent success.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  const grant = await requireManageUsers(supabase, userId, orgId);
  if (grant instanceof NextResponse) return grant;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }

  const parsed = createInvitationSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }

  const { email, firstName, lastName, role, companyIds, adminScope } = parsed.data;
  const normalizedEmail = email.trim().toLowerCase();
  const admin = createAdminSupabase();

  // Delegated-admin responsibility only applies to admin-level roles (those that can
  // manage users). For every other role we ignore any submitted scope — their access
  // is governed by their RBAC role. null == unrestricted (full admin) == today.
  const effectiveScope = isAdminLevelRole(role) ? normalizeAdminScopeForStorage(adminScope) : null;

  // Don't invite someone who already has a seat in this org (case-insensitive).
  const { data: existingEmp } = await supabase
    .schema('core')
    .from('employees')
    .select('id')
    .eq('org_id', orgId!)
    .ilike('email', normalizedEmail)
    .limit(1);
  if (existingEmp && existingEmp.length > 0) {
    return NextResponse.json(
      { error: 'Someone with that email is already on the team.', code: 'ALREADY_MEMBER' },
      { status: 409 },
    );
  }

  const locationIds = isAllCompaniesScope(role) ? [] : companyIds;
  const token = generateInviteToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const baseRow = {
    org_id: orgId!,
    email: normalizedEmail,
    role,
    first_name: firstName?.trim() || null,
    last_name: lastName?.trim() || null,
    location_ids: locationIds,
    token,
    status: 'pending' as const,
    invited_by_clerk: userId,
    expires_at: expiresAt,
  };

  // Persist the capability set when we have one. Degrade-safe: if the admin_scope
  // column isn't migrated yet, retry the insert WITHOUT it so invites still work
  // (the delegation distinction simply isn't stored until the migration lands).
  const insertInvite = (withScope: boolean) =>
    admin
      .schema(INVITATIONS_SCHEMA)
      .from(INVITATIONS_TABLE)
      .insert(withScope ? { ...baseRow, admin_scope: effectiveScope } : baseRow)
      .select(withScope ? SELECT_COLS_WITH_SCOPE : SELECT_COLS)
      .single();

  let insertRes = await insertInvite(Boolean(effectiveScope));
  if (effectiveScope && insertRes.error && isMissingScopeColumn(insertRes.error)) {
    insertRes = await insertInvite(false);
  }
  // The runtime-ternary select confuses the row-type parser; the shape is known.
  const created = insertRes.data as unknown as InvitationRow | null;
  const insErr = insertRes.error;

  if (insErr || !created) {
    if (isMissingInvitationsTable(insErr)) {
      return NextResponse.json(
        {
          error: 'Invitations are not available yet.',
          code: 'INVITATIONS_UNAVAILABLE',
          detail: 'The membership_invitations migration has not been applied to the database.',
        },
        { status: 503 },
      );
    }
    // A pending invite for this email already exists (unique partial index).
    if (insErr?.code === '23505') {
      return NextResponse.json(
        { error: 'There is already a pending invitation for that email.', code: 'DUPLICATE_INVITE' },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: insErr?.message ?? 'Failed to create invitation', code: 'INSERT_ERROR' },
      { status: 500 },
    );
  }

  // --- Best-effort email delivery -------------------------------------------------
  const acceptUrl = inviteAcceptUrl(token);
  const roleLabel = ROLE_DEFINITIONS[role]?.label ?? role;
  let emailSent = false;
  let emailError: string | undefined;

  const provider = resolveEmailProvider();
  const from = resolveFromAddress();
  if (!provider || !from) {
    emailError = 'Email is not configured (RESEND_API_KEY / INVITE-from address). Share the link manually.';
  } else {
    // Org name for the email body (best-effort).
    const { data: org } = await supabase
      .schema('core')
      .from('organizations')
      .select('name')
      .eq('id', orgId!)
      .maybeSingle();
    const { subject, html, text } = buildInvitationEmail({
      orgName: (org?.name as string) || 'MeritBooks',
      roleLabel,
      acceptUrl,
      email: normalizedEmail,
    });
    try {
      await provider.send({ to: [normalizedEmail], subject, html, text }, from);
      emailSent = true;
    } catch (e) {
      emailError = e instanceof EmailSendError ? e.message : e instanceof Error ? e.message : 'Send failed.';
      console.error('[invite send] provider rejected', normalizedEmail, emailError);
    }
  }

  await logHumanAction(supabase, userId, orgId!, {
    action: 'team.invitation.create',
    subjectTable: 'membership_invitations',
    subjectId: created.id as string,
    summary: `Invited ${normalizedEmail} as ${roleLabel}${
      effectiveScope ? ` (${effectiveScope.join('+').toLowerCase()})` : ''
    }${emailSent ? '' : ' (email not sent)'}`,
    metadata: { role, companyIds: locationIds, adminScope: effectiveScope, emailSent },
  });

  return NextResponse.json(
    { data: mapPending(created as InvitationRow), emailSent, emailError, acceptUrl },
    { status: 201 },
  );
}
