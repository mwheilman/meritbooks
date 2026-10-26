'use client';

/**
 * ConfidenceExplainer — an inline, read-only "why this confidence?" surface for a
 * single bank-feed row. It reuses the existing deterministic insight endpoint
 * (`/api/bank-feed/[id]/insight`) which computes the DOCUMENTED composite match
 * score (Vendor 40% + Amount 40% + Date 20%) and the auto-approve check breakdown
 * server-side. NOTHING here calls a live model — it's pure arithmetic surfaced to
 * the reviewer, so it works even while AI categorization is unavailable.
 *
 * A kit dialog (portal, focus-trapped, Esc / scrim to close) so it never gets
 * clipped by the table's horizontal scroll and stays keyboard-usable. Esc is
 * captured at the document so the list behind it never sees the keystroke.
 */

import { useEffect } from 'react';
import { Button, Conf, Dialog, InlineNotice, NotePanel, PanelSection } from '@meritbooks/merit-ui';
import type { BankFeedRow } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { AutoApproveSection, MatchScoreSection, type AutoApproveInsight, type MatchBreakdownInsight } from './insight-parts';
import s from './bank-feed-panels.module.css';

interface InsightResponse {
  autoApprove: AutoApproveInsight;
  match: MatchBreakdownInsight;
}

export function ConfidenceExplainer({
  transaction,
  onClose,
}: {
  transaction: BankFeedRow;
  onClose: () => void;
}) {
  const { data: insight, isLoading, error, refetch } = useQuery<InsightResponse>(
    `/api/bank-feed/${transaction.id}/insight`,
    undefined,
    { scope: false },
  );

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  const aiPct = transaction.ai_confidence == null ? null : Math.round(transaction.ai_confidence * 100);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Why this confidence"
      width={520}
      footNote="Computed from your own rules and history. No AI call."
      actions={
        <Button variant="quiet" onClick={onClose} chord="escape">
          Close
        </Button>
      }
    >
      <p className={s.flagDesc} title={transaction.description}>
        {transaction.description}
      </p>

      <div className={s.overall}>
        <span className="eyebrow">AI confidence</span>
        {aiPct == null ? <span className="ink-2">Uncoded</span> : <Conf score={aiPct} />}
      </div>

      {isLoading && (
        <div className={`wg-loading ${s.stateLine}`} aria-busy="true">
          <span className="bar-l" style={{ width: '72%' }} aria-hidden="true" />
          <span className="bar-l" style={{ width: '56%' }} aria-hidden="true" />
          <span className="t-cap" role="status">
            Working out the score breakdown…
          </span>
        </div>
      )}

      {error && !isLoading && (
        <div className={s.stateLine}>
          <InlineNotice tone="neg" title="The score breakdown didn’t load.">
            {error}{' '}
            <Button variant="quiet" onClick={() => void refetch()}>
              Try again
            </Button>
          </InlineNotice>
        </div>
      )}

      {!isLoading && !error && insight && (
        <div className={s.explainBody}>
          {insight.match?.breakdown ? (
            <MatchScoreSection match={insight.match} showExplanation />
          ) : (
            <PanelSection title="Match score">
              <p className="ink-2">
                {insight.match?.matchType && insight.match.matchType !== 'NONE'
                  ? 'Matched by vendor pattern. There is no settled bill to compare amount and date against, so the Vendor / Amount / Date split doesn’t apply here.'
                  : 'No bill or receipt is matched to this line, so there is no Vendor / Amount / Date score to break down. The AI confidence above reflects the coding suggestion only.'}
              </p>
            </PanelSection>
          )}

          {insight.autoApprove && <AutoApproveSection insight={insight.autoApprove} />}

          {transaction.ai_reasoning && (
            <PanelSection>
              <NotePanel tag="AI reasoning">{transaction.ai_reasoning}</NotePanel>
            </PanelSection>
          )}
        </div>
      )}
    </Dialog>
  );
}
