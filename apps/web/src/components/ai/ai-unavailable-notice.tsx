'use client';

/**
 * Calm, reusable "AI is temporarily unavailable" inline notice.
 *
 * Shown on any NL / AI surface when the model can't be reached (org disabled,
 * budget cap, missing/invalid key). It reads as a reassuring pause — not a red
 * error and never a crash. The deterministic parts of the surface (navigation,
 * manual entry, direct reports) keep working around it.
 *
 * Kept intentionally dependency-light so every AI seam can drop it in.
 */

import { Sparkles } from 'lucide-react';
import { BuildStatusBadge } from '@/components/brand';

/** Default copy, mirrored from AI_UNAVAILABLE_MESSAGE in lib/ai/gateway (server). */
const DEFAULT_MESSAGE = 'AI is temporarily unavailable — try again later.';
const DEFAULT_HINT =
  'The rest of MeritBooks works as usual — enter this manually or open the relevant page directly.';

export function AiUnavailableNotice({
  message,
  hint = DEFAULT_HINT,
  className = '',
}: {
  message?: string | null;
  hint?: string | null;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={`flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-3 text-sm text-slate-300 ${className}`}
    >
      <Sparkles size={16} className="mt-0.5 shrink-0 text-indigo-400" />
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-slate-200">{message || DEFAULT_MESSAGE}</p>
          <BuildStatusBadge
            status="degraded"
            label="AI paused"
            title="AI features are temporarily unavailable — the deterministic parts of this screen keep working."
          />
        </div>
        {hint && <p className="mt-1 text-slate-400">{hint}</p>}
      </div>
    </div>
  );
}
