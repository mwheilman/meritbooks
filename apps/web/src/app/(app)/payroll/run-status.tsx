import { Pip, cx, type PipKind, type StatusKind } from '@meritbooks/merit-ui';
import type { RunStatus } from './types';
import s from './payroll.module.css';

/**
 * Payroll-run status: the kit pip shape + word (never colour alone). The standard
 * StatusBadge doesn't know the payroll states (PREVIEWED / RELEASED / PROCESSING /
 * FAILED …), so payroll keeps its own small mapping.
 */

const META: Record<RunStatus, { label: string; kind: StatusKind; pip: PipKind }> = {
  DRAFT: { label: 'Draft', kind: 'track', pip: 'track' },
  PREVIEWED: { label: 'Previewed', kind: 'track', pip: 'open' },
  PENDING_APPROVAL: { label: 'Awaiting approval', kind: 'risk', pip: 'soft' },
  APPROVED: { label: 'Approved', kind: 'track', pip: 'open' },
  // Release is the money-moving step: same calm tone, but the run pipeline and the
  // release confirmation carry the weight, not a colour.
  RELEASED: { label: 'Released', kind: 'track', pip: 'open' },
  PROCESSING: { label: 'Processing', kind: 'risk', pip: 'soft' },
  PAID: { label: 'Paid', kind: 'ready', pip: 'ready' },
  POSTED: { label: 'Posted', kind: 'ready', pip: 'ready' },
  RECONCILED: { label: 'Reconciled', kind: 'ready', pip: 'ready' },
  FAILED: { label: 'Failed', kind: 'blocked', pip: 'blocked' },
  RETURNED: { label: 'Returned (NSF)', kind: 'overdue', pip: 'overdue' },
  REJECTED: { label: 'Rejected', kind: 'blocked', pip: 'blocked' },
  VOID: { label: 'Void', kind: 'track', pip: 'closed' },
};

export function runStatusLabel(status: RunStatus): string {
  return META[status]?.label ?? status;
}

export function RunStatusBadge({ status, size = 'sm' }: { status: RunStatus; size?: 'sm' | 'md' }) {
  const meta = META[status] ?? { label: status, kind: 'track' as StatusKind, pip: 'track' as PipKind };
  return (
    <span className={cx('status', `status--${meta.kind}`)} data-size={size}>
      <Pip kind={meta.pip} />
      {meta.label}
    </span>
  );
}

// ── The run pipeline (S20 `.pipe`) ───────────────────────────────────────────

/** The five steps every run walks, each with one owner. */
export const RUN_STEPS = ['Prepare', 'Approve', 'Release', 'Pay', 'Post'] as const;
export type RunStepIndex = 0 | 1 | 2 | 3 | 4;

/**
 * Where a run sits in the pipeline: the current step (0-based), or `done` once it
 * is posted, plus whether it stopped on a failure at that step.
 */
export function runStage(status: RunStatus, posted: boolean): { current: RunStepIndex | null; done: boolean; failed: boolean } {
  switch (status) {
    case 'DRAFT':
      return { current: 0, done: false, failed: false };
    case 'PREVIEWED':
    case 'PENDING_APPROVAL':
      return { current: 1, done: false, failed: false };
    case 'REJECTED':
      return { current: 1, done: false, failed: true };
    case 'APPROVED':
      return { current: 2, done: false, failed: false };
    case 'RELEASED':
    case 'PROCESSING':
      return { current: 3, done: false, failed: false };
    case 'FAILED':
    case 'RETURNED':
      return { current: 3, done: false, failed: true };
    case 'PAID':
      return posted ? { current: null, done: true, failed: false } : { current: 4, done: false, failed: false };
    case 'POSTED':
    case 'RECONCILED':
      return { current: null, done: true, failed: false };
    case 'VOID':
    default:
      return { current: null, done: false, failed: false };
  }
}

export interface PipeStep {
  label: string;
  who: string;
  state: 'done' | 'cur' | 'attn' | 'todo';
}

/** `<ol class="pipe">` — five steps; the current one is Sky with an Electric top rule. */
export function RunPipeline({
  steps,
  label,
  className,
  aggregate = false,
}: {
  steps: ReadonlyArray<PipeStep>;
  label: string;
  className?: string;
  /** Many runs at once (the list view): highlight every step with work, mark none as "the" current step. */
  aggregate?: boolean;
}) {
  return (
    <ol className={cx('pipe', className)} aria-label={label}>
      {steps.map((st, i) => (
        <li
          key={st.label}
          className={cx(st.state === 'done' && 'is-done', st.state === 'cur' && 'is-cur', st.state === 'attn' && cx('is-cur', s.pipeAttn))}
          aria-current={!aggregate && (st.state === 'cur' || st.state === 'attn') ? 'step' : undefined}
        >
          <span className="no" aria-hidden="true">
            {i + 1}
          </span>
          <span className="lb">
            {st.label}
            <span className="sr">
              {aggregate
                ? ''
                : st.state === 'done' ? ' · done' : st.state === 'cur' ? ' · current' : st.state === 'attn' ? ' · stopped here' : ''}
            </span>
          </span>
          <span className="who" title={st.who}>
            {st.who}
          </span>
        </li>
      ))}
    </ol>
  );
}
