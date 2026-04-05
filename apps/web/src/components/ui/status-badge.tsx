import { clsx } from 'clsx';

type BadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const variantMap: Record<string, BadgeVariant> = {
  // Transaction status
  POSTED: 'success',
  APPROVED: 'success',
  CATEGORIZED: 'info',
  PENDING: 'warning',
  FLAGGED: 'danger',
  POST_ERROR: 'danger',
  VOIDED: 'neutral',

  // Period status
  OPEN: 'success',
  SOFT_CLOSE: 'warning',
  HARD_CLOSE: 'neutral',

  // Approval
  DRAFT: 'neutral',
  REJECTED: 'danger',

  // Bills
  PAID: 'success',
  PARTIALLY_PAID: 'info',
  ON_HOLD: 'danger',
  OVERDUE: 'danger',

  // Jobs
  ACTIVE: 'success',
  BID: 'info',
  COMPLETE: 'neutral',
  CLOSED: 'neutral',
  ON_HOLD_JOB: 'warning',
  CANCELLED: 'danger',

  // Compliance
  FILED: 'success',
  AUTO_VERIFIED: 'success',
  IN_PROGRESS: 'info',

  // Vendor docs
  VALID: 'success',
  EXPIRED: 'danger',
  MISSING: 'danger',
  RECEIVED: 'info',
  VERIFIED: 'success',

  // Cash
  HEALTHY: 'success',
  ADEQUATE: 'info',
  NEAR_MINIMUM: 'warning',
  CRITICAL: 'danger',
};

interface StatusBadgeProps {
  status: string;
  variant?: BadgeVariant;
  size?: 'sm' | 'md';
  dot?: boolean;
  className?: string;
}

export function StatusBadge({ status, variant, size = 'sm', dot = true, className }: StatusBadgeProps) {
  const v = variant ?? variantMap[status] ?? 'neutral';

  const label = status
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full font-medium',
        size === 'sm' && 'px-2 py-0.5 text-2xs',
        size === 'md' && 'px-2.5 py-1 text-xs',
        v === 'success' && 'bg-emerald-500/10 text-emerald-400',
        v === 'warning' && 'bg-amber-500/10 text-amber-400',
        v === 'danger' && 'bg-red-500/10 text-red-400',
        v === 'info' && 'bg-blue-500/10 text-blue-400',
        v === 'neutral' && 'bg-slate-500/10 text-slate-400',
        className
      )}
    >
      {dot && (
        <span
          className={clsx(
            'h-1.5 w-1.5 rounded-full',
            v === 'success' && 'bg-emerald-400',
            v === 'warning' && 'bg-amber-400',
            v === 'danger' && 'bg-red-400',
            v === 'info' && 'bg-blue-400',
            v === 'neutral' && 'bg-slate-500',
          )}
        />
      )}
      {label}
    </span>
  );
}
