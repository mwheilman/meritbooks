'use client';

/**
 * "From your documents" — the module-side face of document intelligence
 * (FPB-document-intelligence §8). Lists the pending proposals made from stored documents
 * for ONE module ("1 lease found in your documents — review"), each with its file, the AI
 * confidence and a one-line summary, and the module's own Review (pre-filled form) /
 * Dismiss. Shows on the empty state too. Renders nothing when there is nothing to review
 * or the person can't act on this module.
 *
 * merit-ui v2.3 only. Additive: a module drops it in above its list.
 */

import { useCallback, useState } from 'react';
import { Button, ButtonLink, ConfirmDialog, Conf, InlineNotice, Tag, toast, useQuery } from '@meritbooks/merit-ui';
import { TARGETS, type TargetKind } from '@/lib/documents/intelligence/types';
import { dismissDocumentProposal, loadDocumentProposal, proposalHref, type ProposalSummaryWithDoc, type ProposalWithDoc } from './intelligence-client';

export interface DocumentProposalsBannerProps {
  kind: TargetKind;
  /** Open the module's own review form pre-filled. Omitted → link to the module with ?proposal=. */
  onReview?: (p: ProposalWithDoc) => void;
  /** Change to refetch (e.g. after the module created a record). */
  refreshKey?: number;
  /** Limit to one company (null proposals — company not known yet — always show). */
  locationId?: string | null;
}

interface ListResponse {
  data: ProposalSummaryWithDoc[];
  count: number;
}

export function DocumentProposalsBanner({ kind, onReview, refreshKey = 0, locationId = null }: DocumentProposalsBannerProps) {
  const [local, setLocal] = useState(0);
  const [dismiss, setDismiss] = useState<ProposalSummaryWithDoc | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const t = TARGETS[kind];
  const { data, error } = useQuery<ListResponse>(
    '/api/documents/proposals',
    { target_kind: kind, location_id: locationId ?? undefined },
    { key: `${refreshKey}:${local}`, scope: false },
  );
  // Native drafts already lodged in the module's own queue show there, not here.
  const rows = (data?.data ?? []).filter((p) => p.mode !== 'native' || !p.native_id);

  const doDismiss = useCallback(
    async (reason?: string) => {
      if (!dismiss) return;
      const err = await dismissDocumentProposal(dismiss.id, reason);
      if (err) toast.error(err);
      else toast(`Dismissed — it stays in Documents.`);
      setDismiss(null);
      setLocal((n) => n + 1);
    },
    [dismiss],
  );

  // The list carries no extracted terms (security review M): load the one proposal first.
  const review = useCallback(
    async (p: ProposalSummaryWithDoc) => {
      if (!onReview) return;
      setOpening(p.id);
      const r = await loadDocumentProposal(p.id);
      setOpening(null);
      if (r.error || !r.proposal) toast.error(r.error ?? 'Could not load the proposal.');
      else onReview({ ...r.proposal, document: r.proposal.document ?? p.document });
    },
    [onReview],
  );

  if (error || rows.length === 0) return null;
  const n = rows.length;

  return (
    <section aria-label={`${t.nounPlural} found in your documents`} style={{ margin: '12px 0 16px' }}>
      <InlineNotice
        tone="info"
        title={`${n} ${n === 1 ? t.noun : t.nounPlural} found in your documents — review.`}
      >
        AI read {n === 1 ? 'it' : 'them'} from files in Documents. Nothing is set up or posted until you review and confirm.
      </InlineNotice>
      <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'grid', gap: 8 }}>
        {rows.map((p) => {
          const pending = p.extract_state === 'pending';
          const failed = p.extract_state === 'failed';
          const score = p.confidence != null ? Math.round(Number(p.confidence) * 100) : null;
          return (
            <li key={p.id} className="row row--between" style={{ border: '1px solid var(--line-2)', padding: '10px 12px', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Tag tone="ai">From document</Tag>
                  <b className="t-body" style={{ overflowWrap: 'anywhere' }}>{p.title ?? t.noun}</b>
                  {score != null && <Conf score={score} />}
                </div>
                <p className="t-cap" style={{ margin: '4px 0 0' }}>
                  {p.document?.file_name ?? 'Document'}
                  {p.summary ? ` // ${p.summary}` : ''}
                </p>
                {(pending || failed || p.last_error) && (
                  <p className="t-cap" style={{ margin: '2px 0 0' }}>
                    {p.mode === 'native' ? p.last_error ?? 'Finish it in Documents.' : pending ? 'AI will read the terms when it’s available — you can review and enter them now.' : p.last_error}
                  </p>
                )}
              </div>
              <span className="btn-row">
                <Button variant="quiet" onClick={() => setDismiss(p)}>
                  Dismiss
                </Button>
                {onReview && p.mode === 'staged' ? (
                  <Button variant="primary" iconAfter="right" disabled={opening === p.id} onClick={() => void review(p)}>
                    {opening === p.id ? 'Opening…' : 'Review'}
                  </Button>
                ) : (
                  <ButtonLink variant="primary" iconAfter="right" href={proposalHref(p)}>
                    Review
                  </ButtonLink>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={!!dismiss}
        onClose={() => setDismiss(null)}
        onConfirm={doDismiss}
        title={`Dismiss this ${t.noun}?`}
        confirmLabel="Dismiss proposal"
        tone="danger"
      >
        <p className="t-body">
          {dismiss?.document?.file_name ?? 'The document'} stays in Documents; we just won’t propose it here again.
        </p>
      </ConfirmDialog>
    </section>
  );
}
