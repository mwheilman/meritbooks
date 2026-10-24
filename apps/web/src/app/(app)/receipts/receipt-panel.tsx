'use client';

import { useState } from 'react';
import { Button, ConfirmDialog, InlineNotice, KV, Panel, PanelSection, Tag, api, toast, useQuery } from '@meritbooks/merit-ui';
import { MATCH_LOOK, SOURCE_LABEL, type ActionResult, type CandidatesResponse, type ReceiptDetail, usd } from './receipts-types';
import s from './receipts.module.css';

const METHOD: Record<string, string> = {
  auto: 'matched automatically',
  confirmed: 'confirmed by a person',
  manual: 'matched by hand',
  request: 'sent for this charge by the cardholder',
};

export function ReceiptPanel({ receiptId, onClose, onChanged }: { receiptId: string; onClose: () => void; onChanged: () => void }) {
  const [key, setKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [keep, setKeep] = useState(false);
  const { data: r, error, isLoading } = useQuery<ReceiptDetail>(`/api/receipts/${receiptId}`, undefined, { key: String(key), scope: false });
  const needsCandidates = !!r && r.matchStatus !== 'matched';
  const { data: cands, isLoading: candLoading } = useQuery<CandidatesResponse>(needsCandidates ? `/api/receipts/${receiptId}/candidates` : null, undefined, { key: String(key), scope: false });

  const act = async (body: Record<string, unknown>) => {
    setBusy(true);
    const res = await api.post<ActionResult>(`/api/receipts/${receiptId}/match`, body);
    setBusy(false);
    if (res.error) {
      toast.error(res.error.error);
      return false;
    }
    toast(res.data?.message ?? 'Done.');
    setKey((k) => k + 1);
    onChanged();
    return true;
  };

  if (error) {
    return (
      <Panel aria-label="Receipt" title="Receipt" onClose={onClose}>
        <InlineNotice tone="neg" title="Couldn’t load this receipt.">
          {error}
        </InlineNotice>
      </Panel>
    );
  }
  if (isLoading || !r) {
    return (
      <Panel aria-label="Receipt" title="Receipt" onClose={onClose}>
        <p className="t-cap">Loading…</p>
      </Panel>
    );
  }

  const isImage = !!r.file?.mimeType?.startsWith('image/') && !/heic|heif/.test(r.file.mimeType ?? '');
  return (
    <Panel
      aria-label="Receipt"
      eyebrow={['Receipt', MATCH_LOOK[r.matchStatus].word]}
      title={r.vendorName ?? 'Unread receipt'}
      meta={[r.receiptDate, r.locationName, SOURCE_LABEL[r.source as keyof typeof SOURCE_LABEL] ?? r.source].filter(Boolean).join(' · ')}
      figure={r.amountCents != null ? usd(r.amountCents) : undefined}
      onClose={onClose}
      foot={
        <div className={s.actions}>
          {r.matchStatus === 'suggested' && (
            <Button variant="primary" disabled={busy} onClick={() => void act({ action: 'confirm' })}>
              Confirm match
            </Button>
          )}
          {r.matchStatus === 'matched' ? (
            <Button disabled={busy} onClick={() => void act({ action: 'unmatch' })}>
              Unmatch
            </Button>
          ) : (
            <>
              <Button disabled={busy} onClick={() => void act({ action: 'rematch' })}>
                Look again
              </Button>
              {r.matchStatus !== 'not_required' && (
                <Button variant="quiet" disabled={busy} onClick={() => setKeep(true)}>
                  Keep without a charge
                </Button>
              )}
            </>
          )}
        </div>
      }
    >
      <PanelSection title="File">
        <div className={s.preview}>
          {r.file ? (
            isImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={r.file.url} alt={`Receipt from ${r.vendorName ?? 'unknown merchant'}`} />
            ) : (
              <a className="link" href={r.file.url} target="_blank" rel="noopener noreferrer">
                Open {r.file.fileName}
              </a>
            )
          ) : (
            <span className="t-cap">No file attached</span>
          )}
        </div>
      </PanelSection>

      {r.flags.length > 0 && (
        <InlineNotice tone="warn" title="Worth a look.">
          {r.flags.includes('amount_differs') && 'The receipt total is not the charge amount. '}
          {r.flags.includes('date_differs') && 'The receipt date is far from the charge date. '}
          {r.flags.includes('memo_missing') && 'Policy asks for a note on what it was for.'}
        </InlineNotice>
      )}

      <PanelSection title="Card charge" meta={r.matchScore != null ? <Tag tone="ai">{Math.round(r.matchScore * 100)}% match</Tag> : undefined}>
        {r.matchedCharge ? (
          <KV
            items={[
              { term: 'Charge', value: r.matchedCharge.description },
              { term: 'Date', value: r.matchedCharge.date },
              { term: 'Amount', value: usd(r.matchedCharge.amountCents) },
              { term: 'How', value: r.matchMethod ? METHOD[r.matchMethod] ?? r.matchMethod : '—' },
              { term: 'Reminders sent', value: String(r.chaseReminderCount) },
            ]}
          />
        ) : candLoading ? (
          <p className="t-cap">Looking for the charge…</p>
        ) : cands && cands.candidates.length > 0 ? (
          <ul className={s.cands}>
            {cands.candidates.map((c) => (
              <li key={c.charge.id}>
                <span>
                  <span className="l1">{c.charge.description}</span>
                  <span className="l2 t-cap">
                    {c.charge.chargeDate}
                    {c.score ? ` · ${Math.round(c.score.total * 100)}%${c.score.amountBasis === 'tip' ? ' · tip added' : ''}` : ''}
                  </span>
                </span>
                <span className="tnum">{usd(c.charge.amountCents)}</span>
                <Button disabled={busy} onClick={() => void act({ action: 'link', transaction_id: c.charge.id })}>
                  Match
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ink-2">No open card charge looks like this yet. Charges post 1–3 days after the purchase; it is checked again every 15 minutes.</p>
        )}
      </PanelSection>

      <PanelSection title="Read from the receipt" meta={r.extraction?.source === 'ai' ? <Tag tone="ai">AI read</Tag> : r.extraction?.source === 'rules' ? <Tag>Rules read</Tag> : undefined}>
        <KV
          items={[
            { term: 'Merchant', value: r.vendorName ?? '—' },
            { term: 'Date', value: r.receiptDate ?? '—' },
            { term: 'Total', value: r.amountCents != null ? usd(r.amountCents) : '—' },
            { term: 'Tax · tip', value: [r.extraction?.taxCents != null ? usd(r.extraction.taxCents) : null, r.extraction?.tipCents != null ? usd(r.extraction.tipCents) : null].filter(Boolean).join(' · ') || '—' },
            { term: 'Card', value: r.extraction?.cardLast4 ? `••${r.extraction.cardLast4}` : '—' },
            { term: 'GL category', value: r.accountLabel ?? 'Not coded yet' },
          ]}
        />
        {r.extractionStatus === 'skipped' && <p className="t-cap">AI is off, so only typed or forwarded details were read.</p>}
      </PanelSection>

      <PanelSection title="From">
        <KV
          items={[
            { term: 'Cardholder', value: r.holder ? `${r.holder.name}${r.holder.email ? ` · ${r.holder.email}` : ''}` : '—' },
            { term: 'Note', value: r.memo ?? '—' },
            { term: 'Job', value: r.jobLabel ?? '—' },
            { term: 'Received', value: r.submittedAt.slice(0, 16).replace('T', ' ') },
          ]}
        />
      </PanelSection>

      <ConfirmDialog
        open={keep}
        onClose={() => setKeep(false)}
        title="Keep this receipt without a card charge?"
        confirmLabel="Keep on file"
        reason={{ label: 'Why?', help: 'For example: paid in cash, or a personal card (reimburse it through an expense report).', minLength: 3 }}
        onConfirm={async (reason) => {
          if (await act({ action: 'not_required', reason: reason ?? '' })) setKeep(false);
        }}
      />
    </Panel>
  );
}
