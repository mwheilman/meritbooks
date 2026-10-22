'use client';

import { useEffect } from 'react';

/** Route-level error (merit-ui error state): what happened, what to do, retry. */
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
    <div className="surface wg-state mb-error-card" role="alert">
      <span className="tag tag--neg">Not loaded</span>
      <span className="t-head">This page didn&apos;t load</span>
      <p>{error.message || 'An unexpected error occurred. The team has been notified.'}</p>
      <div className="btn-row">
        <button type="button" onClick={reset} className="btn btn--primary">
          Try again
        </button>
        <a href="/dashboard" className="btn">
          Go to Home
        </a>
      </div>
      {error.digest && <p className="t-cap tnum">Error ID: {error.digest}</p>}
    </div>
  );
}
