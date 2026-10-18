'use client';

/**
 * Root global error boundary (Next.js App Router).
 *
 * This catches errors thrown in the root layout / any uncaught render error that
 * escapes a nested boundary. It REPLACES the root layout when it renders, so it
 * must supply its own <html>/<body>. It shows a calm, on-brand full-page fallback
 * (never a raw stack) and reports the failure to the observability layer.
 *
 * Nested, in-place recovery is handled by <ErrorBoundary> and route-level
 * error.tsx files; this is the last line of defense.
 */

import { useEffect } from 'react';
import '@/styles/globals.css';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    try {
      void fetch('/api/observability/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: error?.message ?? 'Root render error',
          stack: error?.stack,
          digest: error?.digest,
          route: typeof window !== 'undefined' ? window.location.pathname : undefined,
          label: 'global-error',
        }),
        keepalive: true,
      }).catch(() => {
        /* best-effort */
      });
    } catch {
      /* never throw from the error boundary */
    }
  }, [error]);

  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-slate-950 text-white antialiased">
        <div className="min-h-screen flex items-center justify-center p-6">
          <div className="max-w-md w-full text-center">
            <div className="mx-auto mb-5 h-14 w-14 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
              <svg
                width="26"
                height="26"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#f87171"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </div>
            <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
            <p className="mt-2 text-sm text-slate-400">
              We hit an unexpected error and couldn&apos;t finish loading this page. The issue has been
              reported automatically. You can try again — if it keeps happening, please let us know.
            </p>
            {error?.digest && (
              <p className="mt-3 text-xs font-mono text-slate-600">Reference: {error.digest}</p>
            )}
            <div className="mt-6 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => reset()}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 px-4 py-2 text-sm font-medium text-white transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
              >
                Try again
              </button>
              <a
                href="/dashboard"
                className="inline-flex items-center gap-2 rounded-lg border border-slate-700 hover:border-slate-500 px-4 py-2 text-sm font-medium text-slate-300 transition-colors"
              >
                Go to dashboard
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
