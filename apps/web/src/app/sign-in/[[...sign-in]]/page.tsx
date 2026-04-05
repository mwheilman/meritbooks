import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-950">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-white tracking-tight">
            Merit<span className="text-brand-500">Books</span>
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            AI-native accounting platform
          </p>
        </div>
        <SignIn afterSignInUrl="/dashboard" />
      </div>
    </div>
  );
}
