import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-950">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/meritbooks-logo-dark.svg"
            alt="MeritBooks"
            className="h-9 w-auto"
          />
          <p className="text-sm text-slate-400 mt-3">
            AI-native accounting platform
          </p>
        </div>
        {/* One front door (FPB-onboarding B6): land on the root router, which sends the
            user to their next unfinished thing (org setup → onboarding → dashboard).
            `fallback` (not `force`) so a deep link that bounced to sign-in still returns
            the user to the page they asked for. `signUpUrl` points Clerk's "Sign up"
            footer link at our own /sign-up page (invite-aware), not the hosted portal. */}
        <SignIn fallbackRedirectUrl="/" signUpFallbackRedirectUrl="/" signUpUrl="/sign-up" />
      </div>
    </div>
  );
}
