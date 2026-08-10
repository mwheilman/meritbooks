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
import { AlertTriangle, RotateCcw } from 'lucide-react';

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
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="card p-8 flex flex-col items-center text-center gap-3 border border-red-500/20 bg-red-500/[0.03]"
    >
      <div className="h-11 w-11 rounded-xl bg-red-500/10 flex items-center justify-center">
        <AlertTriangle size={22} className="text-red-400" aria-hidden="true" />
      </div>
      <div>
        <h3 className="text-base font-semibold text-white">This section hit a snag</h3>
        <p className="mt-1 text-sm text-slate-400 max-w-md">
          Something on this view stopped responding. The rest of the app is fine — our team has been
          notified automatically. You can try reloading just this section.
        </p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-1 inline-flex items-center gap-2 rounded-lg bg-emerald-500/90 hover:bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
      >
        <RotateCcw size={15} aria-hidden="true" />
        Try again
      </button>
    </div>
  );
}
