'use client';

import { useState } from 'react';
import {
  Button, ButtonLink, ConfirmDialog, InlineNotice, KV, Panel, PanelSection, Status, WidgetState, api, money, shortDate, toast, useQuery,
} from '@meritbooks/merit-ui';
import type { ApprovalDetail, ApprovalItem, DecideResult } from '@/lib/approvals/types';
import { CONDITION_WORDS, OBJECT_LABELS, REQUEST_WORDS, STEP_WORDS, decideToast, dueText, itemStatus, pct, rolesLine } from '@/lib/approvals/labels';

export interface ApprovalPanelProps {
  item: ApprovalItem;
  canAct: boolean;
  busy: boolean;
  onClose: () => void;
  onApprove: () => void;
  onReject: () => void;
  /** After a withdraw (the list refreshes). */
  onChanged: () => void;
}

const DECISION_WORDS: Readonly<Record<string, string>> = {
  SUBMIT: 'Sent for approval', APPROVE: 'Approved', REJECT: 'Sent back', CANCEL: 'Withdrawn', ESCALATE: 'Escalated', REOPEN: 'Started again',
};

function when(iso: string | null): string {
  return iso ? shortDate(iso.slice(0, 10)) : '—';
}

/** The decision panel: what it is, the context that sums, the chain, the history, the verbs. */
export function ApprovalPanel({ item, canAct, busy, onClose, onApprove, onReject, onChanged }: ApprovalPanelProps) {
  const { data, error, isLoading, refetch } = useQuery<ApprovalDetail>(`/api/approvals/${item.id}`, undefined, { scope: false });
  const [withdraw, setWithdraw] = useState(false);
  const d = data;
  const s = itemStatus(item);
  const fm = item.facts_money;

  const facts = [
    ...(item.amount_cents !== null ? [{ term: 'Amount', value: money(item.amount_cents) }] : []),
    { term: 'Step', value: item.status === 'PENDING' ? `${item.step} of ${item.step_count} · ${item.step_label ?? 'Approver'}` : REQUEST_WORDS[item.status] },
    ...(item.status === 'PENDING' ? [{ term: 'Due', value: dueText(item.due_at) }] : []),
    { term: 'Prepared by', value: item.prepared_by ?? '—' },
    { term: 'Sent', value: `${when(item.submitted_at)}${item.submitted_by ? ` by ${item.submitted_by}` : ''}` },
    ...(item.on_behalf_of ? [{ term: 'You approve for', value: item.on_behalf_of }] : []),
    ...(d?.my_limit_cents != null ? [{ term: 'Your limit', value: money(d.my_limit_cents) }] : []),
    ...(item.facts.week_hours != null ? [{ term: 'Hours this week', value: String(item.facts.week_hours) }] : []),
  ];

  return (
    <Panel
      aria-label={`${item.title}, approval`}
      eyebrow={[OBJECT_LABELS[item.object_type].one, item.company ?? '']}
      title={item.title}
      meta={[item.job_label, item.summary !== item.job_label ? item.summary : null].filter(Boolean).join(' · ') || undefined}
      figure={item.amount_cents !== null ? money(item.amount_cents) : undefined}
      onClose={onClose}
      foot={
        <div className="ap-verbs">
          {item.href && <ButtonLink href={item.href}>Open</ButtonLink>}
          {item.mine && item.status === 'PENDING' && !item.can_act && <Button disabled={busy} onClick={() => setWithdraw(true)}>Withdraw</Button>}
          <span className="sp" />
          {canAct && <Button disabled={busy} chord="r" onClick={onReject}>Send back</Button>}
          {canAct && (
            <Button variant="primary" disabled={busy} chord="a" onClick={onApprove}>
              {item.self_approval ? 'Approve with reason' : item.step < item.step_count ? 'Approve my step' : 'Approve'}
            </Button>
          )}
        </div>
      }
    >
      <PanelSection>
        <Status kind={s.kind}>{s.word}</Status>
        {item.escalated && <p className="ap-sub" style={{ marginTop: 4 }}>Overdue, so it is now open to the escalation approvers too.</p>}
      </PanelSection>

      {(item.facts.over_budget || item.facts.below_margin_floor || item.facts.overtime || item.sod_exception) && (
        <PanelSection>
          {item.facts.over_budget && (
            <InlineNotice tone="warn" title="Over budget">
              {fm?.overrun_cents != null ? `Pushes a cost code ${money(fm.overrun_cents)} over its budget, so it needs an extra approval.` : 'Pushes a cost code over its budget, so it needs an extra approval.'}
            </InlineNotice>
          )}
          {item.facts.below_margin_floor && (
            <InlineNotice tone="warn" title="Below the margin floor">
              {fm?.margin_pct != null || fm?.front_gross_pct != null
                ? `Margin ${pct(fm?.margin_pct ?? fm?.front_gross_pct)} against a floor of ${pct(fm?.margin_floor_pct)}.`
                : 'Priced under the company floor, so it needs a manager.'}
            </InlineNotice>
          )}
          {item.facts.overtime && <InlineNotice tone="warn" title="Overtime week">More than 50 hours this week for this person.</InlineNotice>}
          {item.sod_exception && <InlineNotice tone="info" title="Self-approved">Approved by its preparer with a reason; it is on the exception report.</InlineNotice>}
        </PanelSection>
      )}

      <PanelSection title="Details">
        <KV items={facts} />
        {item.reject_reason && <p className="ap-sub" style={{ marginTop: 8 }}>Reason: {item.reject_reason}</p>}
      </PanelSection>

      {isLoading && !d && <PanelSection><WidgetState state={{ kind: 'loading', label: 'Loading the chain and history', lines: 4 }} /></PanelSection>}
      {error && !d && <PanelSection><WidgetState state={{ kind: 'error', title: 'The chain did not load', body: error, onRetry: () => void refetch() }} /></PanelSection>}

      {d && d.lines.length > 0 && (
        <PanelSection title="Lines">
          <table className="ap-lines">
            <tbody>
              {d.lines.slice(0, 12).map((l, i) => (
                <tr key={i}>
                  <td>{l.description ?? l.type ?? (l.from_cents != null ? 'Cost code' : `Line ${i + 1}`)}</td>
                  <td className="n">
                    {l.from_cents != null && l.to_cents != null ? `${money(l.from_cents)} → ${money(l.to_cents)}` : money(l.amount_cents ?? l.requested_cents ?? 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.lines.length > 12 && <p className="ap-sub">and {d.lines.length - 12} more on the item</p>}
        </PanelSection>
      )}

      {d && (
        <PanelSection title="Chain">
          <ol className="ap-chain">
            {d.steps.map((st) => (
              <li key={st.step}>
                <span className={st.status === 'PENDING' ? 'n now' : 'n'}>{st.step}</span>
                <span>
                  <b>{st.label}</b>{st.condition ? ` · ${CONDITION_WORDS[st.condition] ?? st.condition}` : ''}
                  <span className="ap-sub" style={{ display: 'block' }}>{rolesLine(st.roles)}</span>
                  {st.decided_by && <span className="ap-sub" style={{ display: 'block' }}>{st.decided_by}{st.on_behalf_of ? ` for ${st.on_behalf_of}` : ''} · {when(st.decided_at)}</span>}
                </span>
                <span className="ap-sub">{st.status === 'PENDING' ? (st.escalated ? 'Escalated' : dueText(st.due_at)) : STEP_WORDS[st.status]}</span>
              </li>
            ))}
          </ol>
        </PanelSection>
      )}

      {d && d.history.length > 0 && (
        <PanelSection title="History">
          <ul className="ap-hist">
            {d.history.slice().reverse().map((h, i) => (
              <li key={i}>
                <b>{DECISION_WORDS[h.decision] ?? h.decision}</b> · {h.actor}{h.on_behalf_of ? ` for ${h.on_behalf_of}` : ''} · {when(h.at)}{h.channel === 'phone' ? ' · phone' : ''}
                {h.reason && <span className="why">{h.sod_exception ? 'Self-approval reason: ' : ''}{h.reason}</span>}
              </li>
            ))}
          </ul>
        </PanelSection>
      )}

      <ConfirmDialog
        open={withdraw}
        onClose={() => setWithdraw(false)}
        title={`Withdraw ${item.title}`}
        confirmLabel="Withdraw"
        reason={{ label: 'Why (optional)', minLength: 0 }}
        onConfirm={async (reason) => {
          const r = await api.post<DecideResult>(`/api/approvals/${item.id}/cancel`, { reason: reason || null });
          if (r.error) throw new Error(r.error.error);
          if (r.data) toast(decideToast(r.data));
          onChanged();
        }}
      >
        It leaves every approver&apos;s queue. You can send it again later.
      </ConfirmDialog>
    </Panel>
  );
}
