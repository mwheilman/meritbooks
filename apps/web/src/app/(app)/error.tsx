'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log to error reporting service in production
    console.error('[App Error]', error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] px-4">
      <div className="h-12 w-12 rounded-xl bg-red-500/10 flex items-center justify-center mb-4">
        <AlertTriangle size={24} className="text-red-400" />
      </div>
      <h2 className="text-lg font-semibold text-white mb-2">Something went wrong</h2>
      <p className="text-sm text-slate-400 text-center max-w-md mb-6">
        {error.message || 'An unexpected error occurred. Our team has been notified.'}
      </p>
      <div className="flex items-center gap-3">
        <button onClick={reset} className="btn-primary btn-sm">
          Try again
        </button>
        <a href="/dashboard" className="btn-secondary btn-sm">
          Go to Dashboard
        </a>
      </div>
      {error.digest && (
        <p className="mt-4 text-2xs text-slate-600 font-mono">
          Error ID: {error.digest}
        </p>
      )}
    </div>
  );
}
