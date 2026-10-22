interface SkeletonProps {
  className?: string;
}

/**
 * The kit loading skeleton (the one place the suite allows a shimmer): a square grey
 * bar shaped like the content. Size it with the caller's classes.
 */
export function Skeleton({ className }: SkeletonProps) {
  return <span className={['mb-skel', className].filter(Boolean).join(' ')} aria-hidden="true" />;
}

export function MetricCardSkeleton() {
  return (
    <div className="surface mb-metric" aria-busy="true">
      <span className="mb-skel" style={{ width: 96, height: 12 }} aria-hidden="true" />
      <span className="mb-skel" style={{ width: 128, height: 24, marginTop: 12 }} aria-hidden="true" />
      <span className="mb-skel" style={{ width: 80, height: 12, marginTop: 8 }} aria-hidden="true" />
      <span className="sr" role="status">Loading</span>
    </div>
  );
}

export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="surface mb-table-skel" aria-busy="true">
      <div className="mb-table-skel-row mb-table-skel-head">
        {Array.from({ length: cols }).map((_, i) => (
          <span key={i} className="mb-skel" style={{ width: 80, height: 12 }} aria-hidden="true" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="mb-table-skel-row">
          {Array.from({ length: cols }).map((_, j) => (
            <span key={j} className="mb-skel" style={{ width: j === 0 ? 160 : 96, height: 12 }} aria-hidden="true" />
          ))}
        </div>
      ))}
      <span className="sr" role="status">Loading</span>
    </div>
  );
}
