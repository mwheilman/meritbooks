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
import '@/styles/books.css';

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

  // Last line of defense: replaces the root layout, so it draws its own document in
  // kit classes (Warm page, white card, Electric primary verb).
  return (
    <html lang="en">
      <body>
        <main className="mb-fatal">
          <div className="surface wg-state mb-fatal-card" role="alert">
            <span className="tag tag--neg">Not loaded</span>
            <h1 className="t-section" style={{ color: 'var(--ink)' }}>Something went wrong</h1>
            <p>
              We hit an unexpected error and couldn&apos;t finish loading this page. The issue has been reported
              automatically. Try again — if it keeps happening, let us know.
            </p>
            {error?.digest && <p className="t-cap tnum">Reference: {error.digest}</p>}
            <div className="btn-row">
              <button type="button" onClick={() => reset()} className="btn btn--primary">
                Try again
              </button>
              <a href="/dashboard" className="btn">
                Go to Home
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
