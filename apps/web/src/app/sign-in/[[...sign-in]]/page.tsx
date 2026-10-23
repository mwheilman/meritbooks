import { SignIn } from '@clerk/nextjs';
import { Lockup } from '@meritbooks/merit-ui';

export const metadata = { title: 'Sign in' };

export default function SignInPage() {
  return (
    <main className="mb-auth">
      <div className="mb-auth-col">
        <div className="mb-auth-brand">
          {/* The product lockup file (kit rule 10), full colour on the light page. */}
          <Lockup module="books" variant="full-color" height={32} />
          <p className="eyebrow" style={{ marginTop: 16 }}>
            Sign in<span className="sl" aria-hidden="true">{'//'}</span>The book of record for every client
          </p>
        </div>
        {/* One front door (FPB-onboarding B6): land on the root router, which sends the
            user to their next unfinished thing (org setup → onboarding → dashboard).
            `fallback` (not `force`) so a deep link that bounced to sign-in still returns
            the user to the page they asked for. `signUpUrl` points Clerk's "Sign up"
            footer link at our own /sign-up page (invite-aware), not the hosted portal. */}
        <SignIn fallbackRedirectUrl="/" signUpFallbackRedirectUrl="/" signUpUrl="/sign-up" />
      </div>
    </main>
  );
}
