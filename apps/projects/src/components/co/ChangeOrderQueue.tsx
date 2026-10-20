'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Bands, Button, ConfirmDialog, Field, InlineNotice, Input, KV, Keybar, MoneyInput, Panel, PanelSection, QueueTable, Seg, Status,
  Textarea, WidgetState, count, dayCount, money, shortDate, useEscapeKey,
  type QueueColumn, type QueueGroup,
} from '@meritbooks/merit-ui';
import type { ChangeOrderRow, ChangeOrderStage } from '@/lib/pm/types';
import { CO_STAGE_WORDS, coStatus } from '@/lib/pm/stage';
import { useShell, useVocab } from '@/components/shell/ShellContext';
import { useAction } from '@/components/job/useAction';
import { lower } from '@/lib/pm/vocab';

export interface CoRow extends ChangeOrderRow {
  jobLabel: string | null;
  company: string | null;
}

type Band = 'open' | 'COR' | 'PCO' | 'closed' | 'all';

export interface ChangeOrderQueueProps {
  rows: CoRow[];
  /** Company pages show the job column; the job tab does not. */
  showJob: boolean;
  /** Job tab: allow creating a change order on this job. */
  createForJobId?: string;
  currentUserId: string;
  /** "review" = open COs in Requested / Potential bands; "all" = every stage, open first. */
  mode: 'review' | 'all';
  'aria-label': string;
}

const OPEN: ReadonlySet<ChangeOrderStage> = new Set(['PCO', 'COR']);

export function ChangeOrderQueue(p: ChangeOrderQueueProps) {
  const v = useVocab();
  const { readOnly } = useShell();
  const { run, busy } = useAction();
  const [band, setBand] = useState<Band>(p.mode === 'review' ? (p.rows.some((r) => r.stage === 'COR') ? 'COR' : 'PCO') : 'open');
  const [cursorId, setCursorId] = useState<string | null>(p.rows.find((r) => OPEN.has(r.stage))?.id ?? p.rows[0]?.id ?? null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);
  const [voidCo, setVoidCo] = useState<CoRow | null>(null);

  const visible = useMemo(() => {
    if (band === 'all') return p.rows;
    if (band === 'open') return p.rows.filter((r) => OPEN.has(r.stage));
    if (band === 'closed') return p.rows.filter((r) => !OPEN.has(r.stage));
    return p.rows.filter((r) => r.stage === band);
  }, [p.rows, band]);
  const cursor = p.rows.find((r) => r.id === cursorId) ?? null;
  const url = (co: CoRow) => `/api/jobs/${co.job_id}/change-orders/${co.id}`;

  const approve = async (co: CoRow) => {
    if (!OPEN.has(co.stage)) return;
    const r = await run(`a:${co.id}`, 'post', `${url(co)}/approve`, {}, `Approved ${co.number}`, { quietError: true });
    if (r.error) setNotice({ id: co.id, text: r.error.error });
    else setNotice(null);
  };
  const advance = async (co: CoRow, to: ChangeOrderStage, verb: string) => {
    const r = await run(`m:${co.id}`, 'post', `${url(co)}/advance`, { to }, `${verb} ${co.number}`, { quietError: true });
    if (r.error) setNotice({ id: co.id, text: r.error.error });
    else setNotice(null);
  };

  const columns: QueueColumn<CoRow>[] = [
    { id: 'num', header: 'Number', width: 128, cell: (c) => <span className="code">{c.number}</span> },
    {
      id: 'title',
      header: 'Change',
      cell: (c) => (
        <>
          <span className="l1">{c.title}</span>
          <span className="l2">{[p.showJob ? c.jobLabel : null, p.showJob ? c.company : null, c.reason].filter(Boolean).join(' · ') || ' '}</span>
        </>
      ),
    },
    { id: 'stage', header: 'Stage', width: 128, cell: (c) => { const s = coStatus(c.stage); return <Status kind={s.kind} pip={s.pip}>{CO_STAGE_WORDS[c.stage]}</Status>; } },
    { id: 'amt', header: 'Contract change', numeric: true, width: 136, cell: (c) => money(c.amount_cents) },
    { id: 'cost', header: 'Cost change', numeric: true, width: 120, cell: (c) => (c.cost_impact_cents == null ? '—' : money(c.cost_impact_cents)) },
    { id: 'days', header: 'Days', numeric: true, width: 64, cell: (c) => (c.schedule_days == null ? '—' : count(c.schedule_days)) },
    { id: 'when', header: 'Created', width: 88, cell: (c) => <span className="l2">{shortDate(c.created_at.slice(0, 10))}</span> },
  ];

  const sum = (rs: ReadonlyArray<CoRow>) => rs.reduce((s, r) => s + r.amount_cents, 0);
  const groups: QueueGroup<CoRow>[] | undefined =
    p.mode === 'all' && band === 'all'
      ? [
          { id: 'open', title: 'Open', rows: p.rows.filter((r) => OPEN.has(r.stage)), caption: money(sum(p.rows.filter((r) => OPEN.has(r.stage)))) },
          { id: 'closed', title: 'Decided', rows: p.rows.filter((r) => !OPEN.has(r.stage)) },
        ]
      : undefined;

  const counts = {
    COR: p.rows.filter((r) => r.stage === 'COR'),
    PCO: p.rows.filter((r) => r.stage === 'PCO'),
    open: p.rows.filter((r) => OPEN.has(r.stage)),
    closed: p.rows.filter((r) => !OPEN.has(r.stage)),
  };
  const canAct = !readOnly;
  const showPanel = creating || !!cursor;

  return (
    <div className="stack">
      <div className="row row--between" style={{ alignItems: 'flex-end' }}>
        {p.mode === 'review' ? (
          <div style={{ flex: 1, maxWidth: 640 }}>
            <Bands<Band>
              aria-label={`${v.change_orders} by stage`}
              value={band}
              onChange={setBand}
              items={[
                { value: 'COR', label: 'Requested', count: count(counts.COR.length), caption: `Sent to the customer · ${money(sum(counts.COR))}` },
                { value: 'PCO', label: 'Potential', count: count(counts.PCO.length), caption: `Priced, not sent · ${money(sum(counts.PCO))}` },
              ]}
            />
          </div>
        ) : (
          <Seg<Band>
            aria-label="Show"
            value={band}
            onChange={setBand}
            items={[
              { value: 'open', label: 'Open', count: counts.open.length },
              { value: 'closed', label: 'Decided', count: counts.closed.length },
              { value: 'all', label: 'All', count: p.rows.length },
            ]}
          />
        )}
        {p.createForJobId && canAct && (
          <Button variant="primary" icon="plus" chord="c" bindChord={!creating} onClick={() => { setCreating(true); }}>
            New {lower(v.change_order)}
          </Button>
        )}
      </div>

      <div className={showPanel ? 'mp-split has-panel' : 'mp-split'}>
        <div className="mp-table" style={{ minWidth: 0 }}>
          {visible.length === 0 ? (
            <WidgetState
              state={
                p.rows.length === 0
                  ? {
                      kind: p.mode === 'review' ? 'done' : 'empty',
                      title: p.mode === 'review' ? `No ${lower(v.change_orders)} are waiting` : `No ${lower(v.change_orders)} yet`,
                      body: p.mode === 'review' ? 'Potential and requested changes land here for approval.' : 'Price a change as a potential change order; send it, then approve it once the customer agrees.',
                    }
                  : { kind: 'done', title: band === 'COR' ? 'Nothing is with the customer' : band === 'PCO' ? 'Nothing priced and unsent' : 'Nothing in this view', body: 'Switch the view above to see the others.' }
              }
            />
          ) : (
            <QueueTable
              aria-label={p['aria-label']}
              columns={columns}
              rows={groups ? undefined : visible}
              groups={groups}
              getRowId={(c) => c.id}
              cursorId={cursorId}
              onCursorChange={(id) => { setCursorId(id); setCreating(false); }}
              rowState={(c) => ({ done: c.stage === 'VOID' || c.stage === 'REJECTED', attn: c.stage === 'COR' })}
              onOpen={(c) => { setCursorId(c.id); setCreating(false); }}
              actions={canAct ? [{ key: 'a', label: 'approve', run: (rs) => rs.forEach((c) => void approve(c)) }] : []}
            />
          )}
        </div>

        {creating && p.createForJobId ? (
          <NewCoPanel jobId={p.createForJobId} onClose={() => setCreating(false)} />
        ) : cursor ? (
          <Panel
            eyebrow={[cursor.number ?? v.change_order, CO_STAGE_WORDS[cursor.stage]]}
            title={cursor.title}
            meta={[money(cursor.amount_cents), p.showJob ? cursor.jobLabel : null, cursor.company].filter(Boolean).join(' · ')}
            onClose={() => setCursorId(null)}
            foot={
              canAct ? (
                <CoActions
                  co={cursor}
                  mine={cursor.created_by === p.currentUserId}
                  busy={busy}
                  onApprove={() => void approve(cursor)}
                  onAdvance={(to, verb) => (to === 'VOID' && cursor.stage === 'APPROVED' ? setVoidCo(cursor) : void advance(cursor, to, verb))}
                />
              ) : undefined
            }
          >
            <PanelSection title="Details">
              <KV
                items={[
                  { term: 'Contract change', value: money(cursor.amount_cents) },
                  { term: 'Cost change', value: cursor.cost_impact_cents == null ? '—' : money(cursor.cost_impact_cents) },
                  { term: 'Schedule', value: cursor.schedule_days == null ? '—' : dayCount(cursor.schedule_days) },
                  { term: 'Created', value: shortDate(cursor.created_at.slice(0, 10)) },
                  ...(cursor.approved_at ? [{ term: 'Approved', value: shortDate(cursor.approved_at.slice(0, 10)) }] : []),
                ]}
              />
              {cursor.reason && <p className="t-cap" style={{ marginTop: 12 }}>Reason: {cursor.reason}</p>}
              {cursor.description && <p style={{ marginTop: 8 }}>{cursor.description}</p>}
            </PanelSection>
            {notice?.id === cursor.id && (
              <PanelSection>
                <InlineNotice tone="neg" title="Not changed.">{notice.text}</InlineNotice>
              </PanelSection>
            )}
            {OPEN.has(cursor.stage) && cursor.created_by === p.currentUserId && (
              <PanelSection>
                <InlineNotice tone="info" title="You prepared this one.">Someone else approves it; that keeps preparer and approver apart.</InlineNotice>
              </PanelSection>
            )}
            {p.showJob && (
              <PanelSection>
                <Link className="link" href={`/jobs/${cursor.job_id}?tab=change-orders`}>Open the job</Link>
              </PanelSection>
            )}
          </Panel>
        ) : null}
      </div>

      {visible.length > 0 && (
        <Keybar
          hints={[{ chord: 'j k', label: 'move' }, ...(canAct ? [{ chord: 'a', label: 'approve' }] : []), ...(p.createForJobId && canAct ? [{ chord: 'c', label: `new ${lower(v.change_order)}` }] : [])]}
          note="Approving adds it to the contract and sends the new value to Merit Books"
        />
      )}

      <ConfirmDialog
        open={!!voidCo}
        onClose={() => setVoidCo(null)}
        tone="danger"
        title={`Void ${voidCo?.number ?? ''}`}
        confirmLabel={`Void ${voidCo?.number ?? ''}`}
        onConfirm={async () => {
          if (!voidCo) return;
          const r = await run(`m:${voidCo.id}`, 'post', `${url(voidCo)}/advance`, { to: 'VOID' }, `Voided ${voidCo.number}`, { quietError: true });
          if (r.error) throw new Error(r.error.error);
        }}
      >
        It is approved, so voiding it takes {voidCo ? money(voidCo.amount_cents) : ''} out of the revised contract and sends the change to Merit Books.
      </ConfirmDialog>
    </div>
  );
}

function CoActions({ co, mine, busy, onApprove, onAdvance }: { co: CoRow; mine: boolean; busy: string | null; onApprove: () => void; onAdvance: (to: ChangeOrderStage, verb: string) => void }) {
  const working = busy === `a:${co.id}` || busy === `m:${co.id}`;
  return (
    <div className="btn-row" style={{ width: '100%' }}>
      {co.stage === 'PCO' && <Button disabled={working} onClick={() => onAdvance('COR', 'Sent')}>Send to customer</Button>}
      {co.stage === 'COR' && <Button disabled={working} onClick={() => onAdvance('PCO', 'Moved back')}>Back to potential</Button>}
      {(co.stage === 'PCO' || co.stage === 'COR') && <Button disabled={working} onClick={() => onAdvance('REJECTED', 'Rejected')}>Reject</Button>}
      {co.stage === 'REJECTED' && <Button disabled={working} onClick={() => onAdvance('PCO', 'Reopened')}>Reopen</Button>}
      {co.stage !== 'VOID' && <Button variant="danger" disabled={working} onClick={() => onAdvance('VOID', 'Voided')}>Void</Button>}
      <span className="sp" />
      {(co.stage === 'PCO' || co.stage === 'COR') && (
        <Button variant="primary" chord="a" disabled={working || mine} title={mine ? 'You prepared this change order' : undefined} onClick={onApprove}>
          Approve
        </Button>
      )}
    </div>
  );
}

function NewCoPanel({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const v = useVocab();
  const { run, busy } = useAction();
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  const [days, setDays] = useState('');
  const [reason, setReason] = useState('');
  const [desc, setDesc] = useState('');
  const [stage, setStage] = useState<'PCO' | 'COR'>('PCO');
  const [err, setErr] = useState<Record<string, string>>({});
  useEscapeKey(onClose, busy !== 'create', 'New change order');

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!title.trim()) e.title = 'Name the change.';
    if (amount == null) e.amount = 'Enter the contract change (0 if none).';
    if (days && !/^-?\d+$/.test(days)) e.days = 'Whole days, like 3 or -2.';
    setErr(e);
    if (Object.keys(e).length) return;
    const r = await run<{ number: string }>('create', 'post', `/api/jobs/${jobId}/change-orders`, {
      title: title.trim(), amountCents: amount, costImpactCents: cost, scheduleDays: days ? Number(days) : null,
      reason: reason.trim() || null, description: desc.trim() || null, stage,
    }, (d) => `Created ${d.number}`);
    if (!r.error) onClose();
  };

  return (
    <Panel
      eyebrow={['New', v.change_order]}
      title={title.trim() || `Untitled ${lower(v.change_order)}`}
      meta={amount != null ? `${money(amount)} · the number is assigned when you create it` : 'The number is assigned when you create it'}
      onClose={onClose}
      foot={
        <div className="btn-row" style={{ justifyContent: 'flex-end', width: '100%' }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" chord="mod+enter" bindChord disabled={busy === 'create'} onClick={() => void submit()}>Create {lower(v.change_order)}</Button>
        </div>
      }
    >
      <PanelSection>
        <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <Field label="What changed" error={err.title}><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add two recessed lights in the hallway" maxLength={200} /></Field>
          <div className="mp-form-2">
            <Field label="Contract change" help="Negative for a credit" error={err.amount}><MoneyInput valueCents={amount} onChangeCents={setAmount} allowNegative placeholder="0.00" /></Field>
            <Field label="Cost change" help="Optional; moves the cost estimate"><MoneyInput valueCents={cost} onChangeCents={setCost} allowNegative placeholder="0.00" /></Field>
          </div>
          <div className="mp-form-2">
            <Field label="Schedule days" error={err.days}><Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} placeholder="0" /></Field>
            <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Owner request" maxLength={200} /></Field>
          </div>
          <Field label="Notes"><Textarea value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={2000} /></Field>
          <Field label="Starts as">
            <Seg<'PCO' | 'COR'> aria-label="Starting stage" value={stage} onChange={setStage} items={[{ value: 'PCO', label: 'Potential' }, { value: 'COR', label: 'Requested' }]} />
          </Field>
          <button type="submit" hidden />
        </form>
      </PanelSection>
    </Panel>
  );
}
