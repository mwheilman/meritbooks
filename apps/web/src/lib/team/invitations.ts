/**
 * Team-invitation shared core.
 *
 * An invitation is a first-class, revocable "pending seat": an admin names an email
 * and a role, we email a sign-up link, and on the invitee's first authenticated
 * login the seat is materialized into the SAME core.employees + core.memberships
 * machinery every other member uses (see lib/identity/claim-invitation.ts). Keeping
 * acceptance on the existing, tested employee→membership path means an invited
 * user's role is normalized and reconciled to core.memberships exactly like anyone
 * else's — no Books-private role that can't reconcile.
 *
 * DEGRADE-SAFE: the backing table (core.membership_invitations) ships in a reserved
 * migration applied to Supabase FIRST. Until it exists, every read/write here is
 * caught by isMissingInvitationsTable() and the surfaces report "unavailable until
 * migration" rather than 500ing.
 */

import type { SupabaseClient, PostgrestError } from '@supabase/supabase-js';
import { ROLE_DEFINITIONS, type UserRole } from '@/lib/rbac/permissions';
import { parseAdminScope, type AdminCapability } from '@/lib/team/admin-scope';

/** core.membership_invitations — reserved migration 106 (REPORTED to the lead). */
export const INVITATIONS_SCHEMA = 'core' as const;
export const INVITATIONS_TABLE = 'membership_invitations' as const;

/** How long an invite link stays valid. Mirrors the DB default (belt + braces). */
export const INVITE_TTL_DAYS = 14;

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

/** Raw row shape (subset we select). */
export interface InvitationRow {
  id: string;
  org_id: string;
  email: string;
  role: string;
  first_name: string | null;
  last_name: string | null;
  location_ids: string[] | null;
  token: string;
  status: InvitationStatus;
  invited_by_clerk: string | null;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
  /** Delegated-admin capability set. Absent (undefined) when the admin_scope column
   *  isn't migrated / wasn't selected; null or absent both mean "full admin". */
  admin_scope?: string[] | null;
}

/** API-facing pending-invite shape for the Team surface. */
export interface PendingInvitation {
  id: string;
  email: string;
  role: UserRole;
  roleLabel: string;
  firstName: string | null;
  lastName: string | null;
  invitedAt: string;
  expiresAt: string;
  isExpired: boolean;
  /** Delegated-admin capability set (null = full admin). */
  adminScope: AdminCapability[] | null;
}

/**
 * Is this the "relation does not exist / not in schema cache" error? That is the
 * ONLY error we swallow into a degrade-safe "unavailable" — every other error is a
 * real failure the caller must surface. PostgREST reports a missing table as
 * PGRST205 (schema cache) or PG 42P01 (undefined_table).
 */
export function isMissingInvitationsTable(
  error: PostgrestError | { code?: string; message?: string } | null | undefined,
): boolean {
  if (!error) return false;
  const code = 'code' in error ? error.code : undefined;
  if (code === '42P01' || code === 'PGRST205' || code === 'PGRST202') return true;
  const msg = ('message' in error ? error.message : '') ?? '';
  return /could not find the table|does not exist|schema cache/i.test(msg);
}

/** Opaque, URL-safe invite token. Crypto-random; the email carries it in the link. */
export function generateInviteToken(): string {
  // 32 bytes of randomness, hex — long enough to be unguessable, plain ASCII.
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The app origin used to build the sign-up link (same convention as invoice email). */
export function appBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? 'https://meritbooks-web.vercel.app';
}

/** The sign-up link an invitee follows. They must sign up with THIS email. */
export function inviteAcceptUrl(token: string): string {
  return `${appBaseUrl()}/sign-up?invite=${encodeURIComponent(token)}`;
}

export function roleLabelFor(role: string): string {
  return ROLE_DEFINITIONS[role as UserRole]?.label ?? role;
}

export function mapPending(row: InvitationRow): PendingInvitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role as UserRole,
    roleLabel: roleLabelFor(row.role),
    firstName: row.first_name,
    lastName: row.last_name,
    invitedAt: row.created_at,
    expiresAt: row.expires_at,
    isExpired: new Date(row.expires_at).getTime() < Date.now(),
    adminScope: parseAdminScope(row.admin_scope),
  };
}

/** Branded HTML + text for an invitation email. Emerald-on-dark, minimal. */
export function buildInvitationEmail(params: {
  orgName: string;
  roleLabel: string;
  acceptUrl: string;
  email: string;
}): { subject: string; html: string; text: string } {
  const { orgName, roleLabel, acceptUrl, email } = params;
  const subject = `You've been invited to ${orgName} on MeritBooks`;

  const html = `<!doctype html>
<html>
  <body style="margin:0;background:#0b0f14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e2e8f0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0f14;padding:32px 0;">
      <tr><td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#111827;border:1px solid #1f2937;border-radius:12px;overflow:hidden;">
          <tr><td style="padding:28px 32px 8px 32px;">
            <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#10b981;font-weight:600;">MeritBooks</div>
          </td></tr>
          <tr><td style="padding:8px 32px 0 32px;">
            <h1 style="margin:0;font-size:20px;line-height:1.35;color:#ffffff;font-weight:600;">You've been invited to ${escapeHtml(orgName)}</h1>
            <p style="margin:14px 0 0 0;font-size:14px;line-height:1.6;color:#cbd5e1;">
              You've been added to <strong style="color:#ffffff;">${escapeHtml(orgName)}</strong> as
              <strong style="color:#10b981;">${escapeHtml(roleLabel)}</strong>. Accept your invitation to
              set up your login and start working the books.
            </p>
          </td></tr>
          <tr><td style="padding:24px 32px 8px 32px;">
            <a href="${acceptUrl}" style="display:inline-block;background:#10b981;color:#04120b;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:8px;">Accept invitation</a>
          </td></tr>
          <tr><td style="padding:12px 32px 28px 32px;">
            <p style="margin:0;font-size:12px;line-height:1.6;color:#64748b;">
              Sign up with <strong style="color:#94a3b8;">${escapeHtml(email)}</strong> — your role is tied to that address.
              This invitation expires in ${INVITE_TTL_DAYS} days. If you weren't expecting it, you can ignore this email.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  const text = [
    `You've been invited to ${orgName} on MeritBooks.`,
    ``,
    `Role: ${roleLabel}`,
    `Accept your invitation: ${acceptUrl}`,
    ``,
    `Sign up with ${email} — your role is tied to that address.`,
    `This invitation expires in ${INVITE_TTL_DAYS} days.`,
  ].join('\n');

  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A role whose companies are the entire org (no per-location assignment). */
export function isAllCompaniesScope(role: UserRole): boolean {
  const scope = ROLE_DEFINITIONS[role]?.companyScope;
  return scope === 'all' || scope === 'portcos_and_3rdparty';
}

/**
 * Best-effort: mark every pending invitation for this org+email as accepted. Used
 * to tie off an invite when the invitee arrives through the pre-existing
 * employee-claim path (so the pending list clears). Degrade-safe + fail-safe.
 */
export async function markInvitationsAcceptedByEmail(
  admin: SupabaseClient,
  orgId: string,
  email: string,
  clerkUserId: string,
): Promise<void> {
  try {
    await admin
      .schema(INVITATIONS_SCHEMA)
      .from(INVITATIONS_TABLE)
      .update({
        status: 'accepted',
        accepted_at: new Date().toISOString(),
        accepted_clerk_id: clerkUserId,
        updated_at: new Date().toISOString(),
      })
      .eq('org_id', orgId)
      .eq('status', 'pending')
      .ilike('email', email);
  } catch {
    // swallow — the table may not exist yet, or the caller already had a seat.
  }
}
