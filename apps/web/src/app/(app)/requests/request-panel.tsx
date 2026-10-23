'use client';

import { Button, InlineNotice, KV, Panel, PanelSection, Pip, Select, Tag, useQuery } from '@meritbooks/merit-ui';
import { KIND_LABEL } from '@/lib/requests/types';
import { eventWord, relative, stamp, statusLook, type RequestDetailResponse, type RequestEvent, type RequestListRow } from './requests-types';
import s from './requests.module.css';

const SNOOZE = [
  { days: 1, label: '1 day' },
  { days: 3, label: '3 days' },
  { days: 7, label: '1 week' },
  { days: 14, label: '2 weeks' },
];

function markClass(e: RequestEvent): string {
  if (e.event_type === 'sent' && e.delivery_status === 'sent') return `${s.mark} ${s.markSent}`;
  if (['bounced', 'failed', 'complained', 'unsubscribed', 'escalated', 'expired'].includes(e.event_type)) return `${s.mark} ${s.markBad}`;
  if (['skipped', 'deferred', 'snoozed'].includes(e.event_type)) return `${s.mark} ${s.markQuiet}`;
  return s.mark;
}

function actorWord(a: string | null): string | null {
  if (!a) return null;
  if (a === 'system:requests') return 'Automatic';
  if (a === 'recipient') return 'Recipient';
  if (a.startsWith('provider:')) return 'Email provider';
  return 'Team member';
}

export interface RequestPanelProps {
  id: string;
  refreshKey: number;
  onClose: () => void;
  onSendNow: (r: RequestListRow) => void;
  onSnooze: (r: RequestListRow, days: number) => void;
  onCancel: (r: RequestListRow) => void;
  onFulfil: (r: RequestListRow) => void;
}

/** The selected request: what was asked, its schedule, and every event on its timeline. */
export function RequestPanel({ id, refreshKey, onClose, onSendNow, onSnooze, onCancel, onFulfil }: RequestPanelProps) {
  const { data, error, isLoading, refetch } = useQuery<RequestDetailResponse>('/api/requests/detail', { id }, { key: `${id}:${refreshKey}`, scope: false });

  if (error) {
    return (
      <Panel title="Couldn’t load this request" onClose={onClose}>
        <PanelSection>
          <InlineNotice tone="neg" title="Something went wrong.">
            {error}{' '}
            <Button variant="quiet" onClick={() => void refetch()}>
              Try again
            </Button>
          </InlineNotice>
        </PanelSection>
      </Panel>
    );
  }
  if (isLoading || !data) {
    return (
      <Panel title="Loading…" onClose={onClose}>
        <PanelSection>
          <span className="bar-l" style={{ width: '70%' }} aria-hidden="true" />
          <span className="bar-l" style={{ width: '50%' }} aria-hidden="true" />
          <p className="t-cap" role="status">
            Loading the timeline…
          </p>
        </PanelSection>
      </Panel>
    );
  }

  const r = data.request;
  const look = statusLook(r);
  const live = r.status === 'open' || r.status === 'sent' || r.status === 'snoozed';
  const who = r.recipient_name ?? r.recipient_email ?? 'No recipient';

  return (
    <Panel
      eyebrow={[KIND_LABEL[r.kind], data.clientName ?? 'All clients']}
      title={r.title}
      meta={`${who}${r.recipient_email && r.recipient_name ? ` · ${r.recipient_email}` : ''}`}
      onClose={onClose}
      foot={
        live ? (
          <div className={s.actions}>
            <Button variant="primary" chord="s" onClick={() => onSendNow(r)} disabled={!!r.bounced_at}>
              Send now
            </Button>
            <Select aria-label="Snooze for" value="" onChange={(e) => e.target.value && onSnooze(r, Number(e.target.value))} style={{ width: 128 }}>
              <option value="">Snooze…</option>
              {SNOOZE.map((o) => (
                <option key={o.days} value={o.days}>
                  {o.label}
                </option>
              ))}
            </Select>
            <Button chord="f" onClick={() => onFulfil(r)}>
              Mark fulfilled
            </Button>
            <Button variant="quiet" chord="c" onClick={() => onCancel(r)}>
              Cancel
            </Button>
          </div>
        ) : undefined
      }
    >
      <PanelSection
        title="Status"
        meta={
          <span className="mb-sev">
            <Pip kind={look.pip} />
            {look.word}
          </span>
        }
      >
        {r.bounced_at && (
          <InlineNotice tone="neg" title="The email bounced.">
            {r.recipient_email} can’t receive mail. Fix the address on the {r.kind === 'w9' || r.kind === 'coi' ? 'vendor' : 'request'} and send a new request.
          </InlineNotice>
        )}
        {r.unsubscribed_at && (
          <InlineNotice tone="warn" title="The recipient stopped these emails.">
            Follow up another way (phone, or in person).
          </InlineNotice>
        )}
        <KV
          items={[
            { term: 'Asked', value: `${r.sends_count} of ${r.max_sends}` },
            { term: 'Schedule', value: data.cadenceText },
            {
              term: live ? 'Next ask' : r.status === 'fulfilled' ? 'Answered' : 'Closed',
              value: live
                ? r.status === 'snoozed'
                  ? `Snoozed until ${stamp(r.snoozed_until)}`
                  : `${stamp(r.next_send_at)} (${relative(r.next_send_at)})`
                : stamp(r.fulfilled_at ?? r.cancelled_at),
            },
            { term: 'Quiet hours', value: data.quiet ? `${data.quiet.start}–${data.quiet.end} recipient time` : 'None' },
            { term: 'Escalates', value: r.escalated_at ? `Escalated ${stamp(r.escalated_at)}` : r.escalate_after ? `After ${r.escalate_after} unanswered asks` : 'Never' },
            { term: 'Channels', value: r.channels.map((c) => (c === 'in_app' ? 'in-app' : c === 'sms' ? 'text' : c)).join(', ') },
            ...(r.due_date ? [{ term: 'Due', value: r.due_date }] : []),
            ...(r.doc_types.length ? [{ term: 'Documents', value: r.doc_types.join(', ').replace(/_/g, ' ') }] : []),
          ]}
        />
        {r.has_portal_link && (
          <p className="t-cap" style={{ marginTop: 8 }}>
            <Tag>Vendor portal</Tag> The email button opens this vendor’s upload page. The request closes itself when the document arrives.
          </p>
        )}
        {r.fulfilled_note && <p className="ink-2" style={{ marginTop: 8 }}>{r.fulfilled_note}</p>}
        {r.cancel_reason && <p className="ink-2" style={{ marginTop: 8 }}>Cancelled: {r.cancel_reason}</p>}
      </PanelSection>

      {r.message && (
        <PanelSection title="What we asked">
          <p className="ink-2" style={{ whiteSpace: 'pre-line' }}>
            {r.message}
          </p>
        </PanelSection>
      )}

      <PanelSection title="Timeline" meta={<span className="t-cap tnum">{data.events.length}</span>}>
        {data.events.length === 0 ? (
          <p className="ink-2">Nothing has happened yet.</p>
        ) : (
          <ol className={s.timeline} aria-label="Request timeline">
            {[...data.events].reverse().map((e) => (
              <li key={e.id}>
                <span className={markClass(e)} aria-hidden="true" />
                <div>
                  <div className={s.evHead}>
                    <b>{eventWord(e)}</b>
                    <span className="t-cap tnum">{stamp(e.occurred_at)}</span>
                  </div>
                  {e.detail && <div className={`ink-2 ${s.evMeta}`}>{e.detail}</div>}
                  {(e.provider_message_id || actorWord(e.actor)) && (
                    <div className={`t-cap ${s.evMeta}`}>
                      {[actorWord(e.actor), e.provider_message_id ? `${e.provider ?? 'provider'} id ${e.provider_message_id}` : null].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </PanelSection>
    </Panel>
  );
}
