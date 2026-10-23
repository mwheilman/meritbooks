import Link from 'next/link';
import { SignUp } from '@clerk/nextjs';
import { Lockup } from '@meritbooks/merit-ui';
import { createAdminSupabase } from '@/lib/supabase/server';
import { previewInvitationByToken, isWellFormedInviteToken, type InvitationPreview } from '@/lib/team/invitations';

export const metadata = { title: 'Sign up' };

export const dynamic = 'force-dynamic';

/**
 * /sign-up — where every invite email lands (`/sign-up?invite=<token>`, FPB B4).
 *
 * Mirrors /sign-in, plus:
 *   • Reads the invite token and shows WHO invited them, as WHAT, with the email the
 *     seat is tied to prefilled (the seat is claimed on first login by the
 *     Clerk-verified email — lib/identity/claim-invitation.ts — so signing up with a
 *     different address is the #1 way an invite "doesn't work"; we say so up front).
 *   • Preserves the token: it rides on the Clerk user's unsafeMetadata and on the
 *     sign-in link (for invitees who already have a login).
 *   • Honest dead-link states: expired / revoked / already accepted.
 *   • After sign-up the user lands on `/` — the router sends them to their next thing.
 *
 * Public route (middleware `/sign-up(.*)`). The token is the credential; the preview
 * reveals only what the invite email itself contained.
 */
export default async function SignUpPage({
  searchParams,
}: {
  searchParams?: { [key: string]: string | string[] | undefined };
}) {
  const rawInvite = searchParams?.invite;
  const token = Array.isArray(rawInvite) ? rawInvite[0] : rawInvite;
  const hasToken = isWellFormedInviteToken(token);

  let invite: InvitationPreview | null = null;
  if (hasToken) {
    invite = await previewInvitationByToken(createAdminSupabase(), token);
  }

  const inviteQs = hasToken ? `?invite=${encodeURIComponent(token)}` : '';
  const valid = invite?.state === 'valid' ? invite : null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-950 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-6">
          {/* The product lockup file (kit rule 10), full colour on the light page. */}
          <Lockup module="books" variant="full-color" height={32} />
          <p className="text-sm text-slate-400 mt-3">The book of record for every client</p>
        </div>

        {valid && (
          <div className="mb-5 rounded-xl border border-brand-500/30 bg-surface-900 px-4 py-3.5" role="status">
            <p className="text-sm text-white">
              {valid.firstName ? `${valid.firstName}, you've` : "You've"} been invited to{' '}
              <span className="font-semibold">{valid.orgName}</span> as{' '}
              <span className="font-semibold text-brand-400">{valid.roleLabel}</span>.
            </p>
            <p className="mt-1.5 text-xs text-slate-400">
              Sign up with <span className="font-mono text-slate-200">{valid.email}</span> — your access is tied to
              that address. Already have a MeritBooks login with it?{' '}
              <Link href={`/sign-in${inviteQs}`} className="text-brand-400 hover:text-brand-300 underline-offset-2 hover:underline">
                Sign in instead
              </Link>
              .
            </p>
          </div>
        )}

        {invite && invite.state !== 'valid' && (
          <div className="mb-5 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3.5 text-sm text-amber-200" role="alert">
            {invite.state === 'expired' && (
              <>This invitation to <strong>{invite.orgName}</strong> has expired. Ask whoever invited you to resend it — the new email will have a fresh link.</>
            )}
            {invite.state === 'revoked' && (
              <>This invitation to <strong>{invite.orgName}</strong> was cancelled. If that&apos;s a mistake, ask your admin to invite you again.</>
            )}
            {invite.state === 'accepted' && (
              <>
                This invitation to <strong>{invite.orgName}</strong> has already been accepted.{' '}
                <Link href="/sign-in" className="underline underline-offset-2 hover:text-amber-100">Sign in</Link> to continue.
              </>
            )}
            {invite.state === 'not_found' && (
              <>We couldn&apos;t find that invitation. You can still create a login — if you were invited, use the email address the invite was sent to.</>
            )}
          </div>
        )}

        <SignUp
          path="/sign-up"
          routing="path"
          signInUrl={`/sign-in${inviteQs}`}
          forceRedirectUrl="/"
          initialValues={valid ? { emailAddress: valid.email, firstName: valid.firstName ?? undefined } : undefined}
          unsafeMetadata={hasToken ? { inviteToken: token } : undefined}
        />
      </div>
    </div>
  );
}
