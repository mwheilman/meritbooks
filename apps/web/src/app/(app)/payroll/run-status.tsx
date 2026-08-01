import { clsx } from 'clsx';
import type { RunStatus } from './types';

/**
 * Payroll-run status pill. The standard StatusBadge doesn't know the payroll
 * states (PREVIEWED / RELEASED / PROCESSING / FAILED …), and Release deserves a
 * deliberately distinct, money-moving tone, so payroll gets its own small badge.
 */

type Tone = 'draft' | 'info' | 'warn' | 'ok' | 'money' | 'danger';

const META: Record<RunStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Draft', tone: 'draft' },
  PREVIEWED: { label: 'Previewed', tone: 'info' },
  PENDING_APPROVAL: { label: 'Awaiting approval', tone: 'warn' },
  APPROVED: { label: 'Approved', tone: 'ok' },
  RELEASED: { label: 'Released', tone: 'money' },
  PROCESSING: { label: 'Processing', tone: 'warn' },
  PAID: { label: 'Paid', tone: 'ok' },
  POSTED: { label: 'Posted', tone: 'ok' },
  RECONCILED: { label: 'Reconciled', tone: 'ok' },
  FAILED: { label: 'Failed', tone: 'danger' },
  RETURNED: { label: 'Returned (NSF)', tone: 'danger' },
  REJECTED: { label: 'Rejected', tone: 'danger' },
  VOID: { label: 'Void', tone: 'draft' },
};

const TONE_CLASSES: Record<Tone, { pill: string; dot: string }> = {
  draft: { pill: 'bg-slate-500/10 text-slate-400', dot: 'bg-slate-400' },
  info: { pill: 'bg-blue-500/10 text-blue-400', dot: 'bg-blue-400' },
  warn: { pill: 'bg-amber-500/10 text-amber-400', dot: 'bg-amber-400' },
  ok: { pill: 'bg-emerald-500/10 text-emerald-400', dot: 'bg-emerald-400' },
  // Money-movement states get indigo — the same accent the app reserves to say
  // "this is the consequential, irreversible step."
  money: { pill: 'bg-indigo-500/15 text-indigo-300', dot: 'bg-indigo-400' },
  danger: { pill: 'bg-red-500/10 text-red-400', dot: 'bg-red-400' },
};

export function RunStatusBadge({ status, size = 'sm' }: { status: RunStatus; size?: 'sm' | 'md' }) {
  const meta = META[status] ?? { label: status, tone: 'draft' as Tone };
  const c = TONE_CLASSES[meta.tone];
  const processing = status === 'PROCESSING';
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full font-medium',
        size === 'sm' ? 'px-2 py-0.5 text-2xs' : 'px-2.5 py-1 text-xs',
        c.pill,
      )}
    >
      <span className={clsx('w-1.5 h-1.5 rounded-full', c.dot, processing && 'animate-pulse')} />
      {meta.label}
    </span>
  );
}
