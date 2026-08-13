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
        <SignIn afterSignInUrl="/dashboard" />
      </div>
    </div>
  );
}
