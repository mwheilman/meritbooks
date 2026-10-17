import { SignIn } from '@clerk/nextjs';
import { BrandLockup } from '@/components/brand/brand-mark';

export default function SignInPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-950">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <BrandLockup tone="onLight" size={36} />
          <p className="eyebrow mt-4">
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
