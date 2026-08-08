export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requireManageUsers } from '@/lib/team/guard';
import { createAdminSupabase } from '@/lib/supabase/server';
import { ROLE_DEFINITIONS } from '@/lib/rbac/permissions';
import { logHumanAction } from '@/lib/trust/action-log';
import { resolveEmailProvider, resolveFromAddress, EmailSendError } from '@/lib/email/provider';
import {
  INVITATIONS_SCHEMA,
  INVITATIONS_TABLE,
  INVITE_TTL_DAYS,
  isMissingInvitationsTable,
  inviteAcceptUrl,
  buildInvitationEmail,
  type InvitationRow,
} from '@/lib/team/invitations';

/**
 * POST /api/team/invitations/[id]/resend
 * Re-send the invite email for a pending invitation and extend its expiry. Reuses
 * the same token (the link stays valid). Best-effort email, honest emailSent flag.
 */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  const grant = await requireManageUsers(supabase, userId, orgId);
  if (grant instanceof NextResponse) return grant;

  const admin = createAdminSupabase();

  const { data: invite, error } = await admin
    .schema(INVITATIONS_SCHEMA)
    .from(INVITATIONS_TABLE)
    .select('id, org_id, email, role, token, status, expires_at')
    .eq('id', params.id)
    .eq('org_id', orgId!)
    .maybeSingle();

  if (error) {
    if (isMissingInvitationsTable(error)) {
      return NextResponse.json({ error: 'Invitations are not available yet.', code: 'INVITATIONS_UNAVAILABLE' }, { status: 503 });
    }
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }
  const row = invite as Pick<InvitationRow, 'id' | 'org_id' | 'email' | 'role' | 'token' | 'status' | 'expires_at'> | null;
  if (!row || row.status !== 'pending') {
    return NextResponse.json({ error: 'No pending invitation to resend.', code: 'NOT_FOUND' }, { status: 404 });
  }

  // Refresh expiry so a resend gives the invitee a fresh window.
  const newExpiry = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await admin
    .schema(INVITATIONS_SCHEMA)
    .from(INVITATIONS_TABLE)
    .update({ expires_at: newExpiry, updated_at: new Date().toISOString() })
    .eq('id', row.id);

  const acceptUrl = inviteAcceptUrl(row.token);
  const roleLabel = ROLE_DEFINITIONS[row.role as keyof typeof ROLE_DEFINITIONS]?.label ?? row.role;
  let emailSent = false;
  let emailError: string | undefined;

  const provider = resolveEmailProvider();
  const from = resolveFromAddress();
  if (!provider || !from) {
    emailError = 'Email is not configured. Share the link manually.';
  } else {
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
      email: row.email,
    });
    try {
      await provider.send({ to: [row.email], subject, html, text }, from);
      emailSent = true;
    } catch (e) {
      emailError = e instanceof EmailSendError ? e.message : e instanceof Error ? e.message : 'Send failed.';
      console.error('[invite resend] provider rejected', row.email, emailError);
    }
  }

  await logHumanAction(supabase, userId, orgId!, {
    action: 'team.invitation.resend',
    subjectTable: 'membership_invitations',
    subjectId: row.id,
    summary: `Resent invitation for ${row.email}${emailSent ? '' : ' (email not sent)'}`,
    metadata: { emailSent },
  });

  return NextResponse.json({ data: { id: row.id }, emailSent, emailError, acceptUrl });
}
