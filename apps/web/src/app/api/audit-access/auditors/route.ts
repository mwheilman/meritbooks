export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requireManageUsers } from '@/lib/team/guard';
import { inviteAuditorSchema } from '@/lib/audit-access/validation';
import {
  provisionExternalAuditorRole,
  EXTERNAL_AUDITOR_ROLE_KEY,
  EXTERNAL_AUDITOR_ROLE_NAME,
} from '@/lib/audit-access/external-auditor-role';
import { logHumanAction } from '@/lib/trust/action-log';
import { resolveEmailProvider, resolveFromAddress, EmailSendError } from '@/lib/email/provider';
import { generateInviteToken, inviteAcceptUrl, buildInvitationEmail } from '@/lib/team/invitations';

interface AuditorRow {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  clerk_user_id: string | null;
  is_active: boolean;
  created_at: string;
}

function displayName(r: AuditorRow): string {
  const n = [r.first_name, r.last_name].filter(Boolean).join(' ').trim();
  return n || r.email || 'Unnamed';
}

/**
 * GET /api/audit-access/auditors — admin-only list of the org's external auditor seats
 * (claimed and pending), so the admin surface can show + revoke them.
 */
export async function GET(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  const grant = await requireManageUsers(supabase, userId, orgId);
  if (grant instanceof NextResponse) return grant;

  const { data, error } = await supabase
    .schema('core')
    .from('employees')
    .select('id, email, first_name, last_name, clerk_user_id, is_active, created_at')
    .eq('org_id', orgId!)
    .eq('role', EXTERNAL_AUDITOR_ROLE_KEY)
    .order('created_at', { ascending: false });
  if (error) {
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }
  const rows = (data ?? []) as AuditorRow[];
  return NextResponse.json({
    data: rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: displayName(r),
      isActive: r.is_active,
      claimed: Boolean(r.clerk_user_id),
      createdAt: r.created_at,
    })),
  });
}

/**
 * POST /api/audit-access/auditors — invite an outside CPA/auditor with VIEW-ONLY access.
 *
 * Steps (all admin-gated): (1) provision the read-only External Auditor custom role for the
 * org (idempotent); (2) create an UNCLAIMED employee seat carrying that role — on the
 * invitee's first login /api/me matches it by verified email and links their Clerk id, so
 * the custom role reaches core.employees.role and is enforced by effectivePermission;
 * (3) grant the auditor's company visibility (selected companies, or all); (4) best-effort
 * email a sign-up link. The seat mechanism (unclaimed row) works even if email isn't
 * configured — the returned acceptUrl can be shared manually.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  const grant = await requireManageUsers(supabase, userId, orgId);
  if (grant instanceof NextResponse) return grant;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = inviteAuditorSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }
  const { email, firstName, lastName, companyIds } = parsed.data;
  const normalizedEmail = email.trim().toLowerCase();

  // 1. Provision the read-only role (idempotent).
  try {
    await provisionExternalAuditorRole(supabase, orgId!, userId);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not provision the auditor role', code: 'PROVISION_FAILED' },
      { status: 500 },
    );
  }

  // 2. Reject a duplicate seat for this email.
  const { data: existing } = await supabase
    .schema('core')
    .from('employees')
    .select('id')
    .eq('org_id', orgId!)
    .ilike('email', normalizedEmail)
    .limit(1);
  if (existing && existing.length > 0) {
    return NextResponse.json(
      { error: 'Someone with that email already has a seat in this organization.', code: 'ALREADY_MEMBER' },
      { status: 409 },
    );
  }

  // 3. Create the unclaimed seat carrying the External Auditor role.
  const { data: seat, error: seatErr } = await supabase
    .schema('core')
    .from('employees')
    .insert({
      org_id: orgId!,
      clerk_user_id: null,
      first_name: firstName?.trim() || '',
      last_name: lastName?.trim() || '',
      email: normalizedEmail,
      role: EXTERNAL_AUDITOR_ROLE_KEY,
      is_active: true,
    })
    .select('id')
    .single();
  if (seatErr || !seat) {
    return NextResponse.json(
      { error: seatErr?.message ?? 'Could not create the auditor seat', code: 'SEAT_FAILED' },
      { status: 500 },
    );
  }

  // 4. Grant company visibility. Custom roles have no company scope, so the auditor sees
  //    only the companies granted here (selected, or every company in the org).
  let grantedCompanyIds = companyIds;
  if (grantedCompanyIds.length === 0) {
    const { data: locs } = await supabase.schema('core').from('locations').select('id').eq('org_id', orgId!);
    grantedCompanyIds = (locs ?? []).map((l: { id: string }) => l.id);
  }
  if (grantedCompanyIds.length > 0) {
    const { error: locErr } = await supabase.from('employee_locations').insert(
      grantedCompanyIds.map((location_id) => ({ employee_id: seat.id as string, location_id, org_id: orgId! })),
    );
    if (locErr) console.error('[audit-access] location grant failed:', locErr.message);
  }

  // 5. Best-effort email a sign-up link (the seat claims by verified email on first login).
  const token = generateInviteToken();
  const acceptUrl = inviteAcceptUrl(token);
  let emailSent = false;
  let emailError: string | undefined;
  const provider = resolveEmailProvider();
  const from = resolveFromAddress();
  if (!provider || !from) {
    emailError = 'Email is not configured. Share the sign-up link manually.';
  } else {
    const { data: org } = await supabase.schema('core').from('organizations').select('name').eq('id', orgId!).maybeSingle();
    const { subject, html, text } = buildInvitationEmail({
      orgName: (org?.name as string) || 'MeritBooks',
      roleLabel: EXTERNAL_AUDITOR_ROLE_NAME,
      acceptUrl,
      email: normalizedEmail,
    });
    try {
      await provider.send({ to: [normalizedEmail], subject, html, text }, from);
      emailSent = true;
    } catch (e) {
      emailError = e instanceof EmailSendError ? e.message : e instanceof Error ? e.message : 'Send failed.';
      console.error('[audit-access] email send failed:', emailError);
    }
  }

  await logHumanAction(supabase, userId, orgId!, {
    action: 'audit_access.auditor.invite',
    subjectTable: 'employees',
    subjectId: seat.id as string,
    summary: `Invited external auditor ${normalizedEmail} (view-only)${emailSent ? '' : ' (email not sent)'}`,
    metadata: { email: normalizedEmail, companyIds: grantedCompanyIds, emailSent },
  });

  return NextResponse.json({ data: { id: seat.id, email: normalizedEmail }, emailSent, emailError, acceptUrl }, { status: 201 });
}
