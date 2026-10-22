import { Icon } from '@meritbooks/merit-ui';

interface EmptyStateProps {
  /** Accepted for compatibility; the kit's dashed mark replaces stock icons. */
  icon?: unknown;
  title: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

/**
 * The kit empty state (§7.12): a dashed mark, what's empty, what to do, one verb.
 * Never "No data".
 */
export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div className={['wg-state', 'mb-empty', className].filter(Boolean).join(' ')}>
      <span className="wg-empty-mark" aria-hidden="true">
        <Icon name="plus" />
      </span>
      <span className="t-head">{title}</span>
      <p>{description}</p>
      {action && (
        <button type="button" onClick={action.onClick} className="btn btn--primary">
          {action.label}
        </button>
      )}
    </div>
  );
}
