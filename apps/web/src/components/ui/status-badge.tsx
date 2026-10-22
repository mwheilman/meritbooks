import { Pip, type PipKind, type TagTone } from '@meritbooks/merit-ui';

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
  SCHEDULED: 'info',
  ON_HOLD: 'danger',
  OVERDUE: 'danger',

  // Cost attribution lifecycle
  CLEARED: 'success',

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

// Kit status grammar (§7.4): a pip SHAPE + the word, washed by meaning — never colour alone.
const TONE: Record<BadgeVariant, TagTone> = {
  success: 'pos',
  warning: 'warn',
  danger: 'neg',
  info: 'ai',
  neutral: 'default',
};
const PIP: Record<BadgeVariant, PipKind> = {
  success: 'ready',
  warning: 'risk',
  danger: 'overdue',
  info: 'open',
  neutral: 'closed',
};

/** A status word as a kit tag (20px, square) with its pip. Same props as before. */
export function StatusBadge({ status, variant, size = 'sm', dot = true, className }: StatusBadgeProps) {
  const v = variant ?? variantMap[status] ?? 'neutral';

  const label = status
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());

  const tone = TONE[v];
  return (
    <span
      className={['tag', tone !== 'default' && `tag--${tone}`, size === 'md' && 'mb-tag--md', className].filter(Boolean).join(' ')}
    >
      {dot && <Pip kind={PIP[v]} />}
      {label}
    </span>
  );
}
