'use client';

/**
 * <ErrorBoundary> — a reusable client error boundary for any interactive subtree.
 *
 * When a child throws during render, this catches it, shows a calm, on-brand
 * fallback (NOT a raw stack trace), and reports the error to the observability
 * layer via POST /api/observability/client-error (best-effort, never blocks the
 * UI). Wrap risky client trees:
 *
 *   <ErrorBoundary label="bank-feed">
 *     <BankFeed />
 *   </ErrorBoundary>
 *
 * React error boundaries must be class components, so this is the one class in the
 * codebase — the rest of the app stays functional.
 */

import React from 'react';

interface Props {
  children: React.ReactNode;
  /** Short area label recorded with the report (e.g. "reports", "bank-feed"). */
  label?: string;
  /** Optional custom fallback. When omitted, the default on-brand card renders. */
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

function reportClientError(error: unknown, componentStack: string | undefined, label?: string) {
  try {
    const payload = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      componentStack,
      route: typeof window !== 'undefined' ? window.location.pathname : undefined,
      label,
    };
    // keepalive so the report still flushes if the boundary unmounts / navigates.
    void fetch('/api/observability/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {
      /* reporting is best-effort */
    });
  } catch {
    /* a boundary must never throw */
  }
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: unknown): State {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : 'Something went wrong.',
    };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    reportClientError(error, info?.componentStack ?? undefined, this.props.label);
  }

  private handleRetry = () => this.setState({ hasError: false, message: '' });

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return <>{this.props.fallback}</>;
    return <FallbackCard onRetry={this.handleRetry} />;
  }
}

function FallbackCard({ onRetry }: { onRetry: () => void }) {
  // Kit error state (§7.12): what happened, what to do, retry — never a raw stack.
  return (
    <div role="alert" aria-live="assertive" className="surface wg-state mb-error-card">
      <span className="tag tag--neg">Not loaded</span>
      <span className="t-head">This section hit a snag</span>
      <p>
        Something on this view stopped responding. The rest of the app is fine — the team has been notified
        automatically. You can try reloading just this section.
      </p>
      <button type="button" onClick={onRetry} className="btn btn--primary">
        Try again
      </button>
    </div>
  );
}
