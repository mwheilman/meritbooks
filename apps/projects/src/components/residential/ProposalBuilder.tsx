'use client';

import { useMemo, useState } from 'react';
import {
  AppLink, Button, Dialog, Field, InlineNotice, Input, KV, Select, Tabs, Tag, Textarea, count, money, pct, shortDate,
} from '@meritbooks/merit-ui';
import type { CatalogItemRow, AssemblyRow } from '@/lib/residential/types';
import type { ProposalBundle } from '@/lib/residential/queries';
import { CONTRACT_SHORT, METHOD_WORDS, PROPOSAL_STATUS, proposalMoves, sendBlocker } from '@/lib/residential/labels';
import { useMoneyVis, useShell } from '@/components/shell/ShellContext';
import { Failure, Section, StatusMark } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';
import { ProposalScope } from './ProposalScope';
import { ProposalOptions, ProposalPayments, ProposalTerms } from './ProposalTerms';

type Tab = 'scope' | 'options' | 'payments' | 'terms' | 'history';

export interface ProposalBuilderProps {
  bundle: ProposalBundle;
  catalog: { items: CatalogItemRow[]; assemblies: AssemblyRow[] };
  today: string;
  canEdit: boolean;
}

export function ProposalBuilder({ bundle: b, catalog, today, canEdit }: ProposalBuilderProps) {
  const p = b.proposal;
  const mv = useMoneyVis();
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const [tab, setTab] = useState<Tab>('scope');
  const [dialog, setDialog] = useState<'accept' | 'sign' | 'decline' | null>(null);
  const envelopeOpen = !!b.envelope && (b.envelope.status === 'sent' || b.envelope.status === 'draft');
  const moves = proposalMoves(p, envelopeOpen);
  const editable = moves.edit && canEdit && !readOnly;
  const url = `/api/residential/proposals/${p.id}`;
  const schedulePct = useMemo(() => {
    if (!b.schedule.length || b.schedule.some((s) => s.kind === 'FINAL' && s.pct == null && s.amount_cents == null)) return null;
    if (b.schedule.some((s) => s.amount_cents != null && s.pct == null)) return null;
    return b.schedule.reduce((s, r) => s + (r.pct ?? 0), 0);
  }, [b.schedule]);
  const blocker = moves.send ? sendBlocker({ lines: b.lines, options: b.options, schedulePctSum: schedulePct }) : null;
  const margin = mv.cost && mv.contract && p.cost_cents != null && p.total_cents > 0 ? (p.total_cents - p.cost_cents) / p.total_cents : null;
  const result = p.status === 'ACCEPTED' && 'job_id' in p.result ? p.result : null;

  const send = () => void act<{ status?: string }>('send', 'post', url, { op: 'send' }, (d) => (d?.status === 'approval_required' ? 'Below the margin floor: sent to Approvals first' : 'Proposal sent — versioned and locked'));

  return (
    <div className="stack">
      <div className="ops-toolbar" style={{ alignItems: 'flex-start' }}>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <StatusMark mark={PROPOSAL_STATUS[p.status]} />
          <Tag>{CONTRACT_SHORT[p.contract_type]}</Tag>
          {p.version > 1 && <Tag>Version {p.version}</Tag>}
          {p.status === 'SENT' && (p.view_count ? <Tag tone="pos">Opened {count(p.view_count)}×</Tag> : <Tag tone="warn">Not opened yet</Tag>)}
          {p.valid_until && p.status === 'SENT' && p.valid_until < today && <Tag tone="neg">Expired {shortDate(p.valid_until, today)}</Tag>}
          {envelopeOpen && <Tag tone="ai">Out for e-signature</Tag>}
        </div>
        <span className="sp" />
        {!readOnly && canEdit && (
          <div className="btn-row">
            {moves.decline && <Button variant="quiet" onClick={() => setDialog('decline')}>Declined</Button>}
            {moves.revise && <Button onClick={() => void act('revise', 'post', url, { op: 'revise' }, 'New version opened as a draft')} disabled={busy === 'revise'}>Revise</Button>}
            {moves.sign && <Button onClick={() => setDialog('sign')}>Request e-signature</Button>}
            {moves.accept && <Button variant="primary" onClick={() => setDialog('accept')}>Accept and build the job</Button>}
            {moves.send && <Button variant="primary" disabled={!!blocker || busy === 'send'} title={blocker ?? undefined} onClick={send}>Send proposal</Button>}
          </div>
        )}
      </div>
      {blocker && editable && <InlineNotice tone="info" title="Before it can go out">{blocker}</InlineNotice>}
      <Failure text={error} />
      {result && (
        <InlineNotice tone="info" title="Accepted — the job is built">
          {money(result.contract_cents)} contract{result.deposit_cents ? `, ${money(result.deposit_cents)} deposit requested` : ''}, {count(result.selections_created)} selections, {count(result.household_invites)} portal invites.
          {' '}<AppLink href={`/homes/${result.job_id}`}>Open the home workspace</AppLink>
          {result.warnings.length > 0 && <ul style={{ margin: '6px 0 0 18px' }}>{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
        </InlineNotice>
      )}

      <div className="ops-split has-panel" style={{ gridTemplateColumns: 'minmax(0, 1fr) 320px' }}>
        <div style={{ minWidth: 0 }} className="stack">
          <Tabs<Tab> aria-label="Proposal sections" value={tab} onChange={setTab} items={[
            { value: 'scope', label: 'Scope', count: count(b.lines.filter((l) => !l.option_id).length) },
            { value: 'options', label: 'Options', count: count(b.options.length) },
            { value: 'payments', label: 'Payments', count: count(b.schedule.length) },
            { value: 'terms', label: 'Terms' },
            { value: 'history', label: 'History', count: count(b.snapshots.length) },
          ]} />
          {tab === 'scope' && <ProposalScope proposal={p} lines={b.lines} options={b.options} catalog={catalog} editable={editable} />}
          {tab === 'options' && <ProposalOptions proposal={p} options={b.options} lines={b.lines} editable={editable} canChoose={canEdit && !readOnly && (p.status === 'DRAFT' || p.status === 'SENT')} />}
          {tab === 'payments' && <ProposalPayments proposal={p} schedule={b.schedule} editable={editable} />}
          {tab === 'terms' && <ProposalTerms proposal={p} editable={editable} />}
          {tab === 'history' && (
            <Section title="Versions and signatures">
              {b.snapshots.length === 0 && !b.envelope ? <p className="t-cap">Nothing sent yet. Each send keeps a frozen copy here.</p> : (
                <KV items={[
                  ...b.snapshots.map((s) => ({ term: `Version ${s.version}`, value: `${mv.contract ? money(s.total_cents) : '—'} · sent ${shortDate(s.sent_at.slice(0, 10), today)}` })),
                  ...(p.first_viewed_at ? [{ term: 'First opened', value: shortDate(p.first_viewed_at.slice(0, 10), today) }] : []),
                  ...(b.envelope ? [{ term: 'E-signature', value: `${b.envelope.status}${b.envelope.completed_at ? ` · ${shortDate(b.envelope.completed_at.slice(0, 10), today)}` : ''}` }] : []),
                  ...(p.signed_by_name ? [{ term: 'Signed by', value: `${p.signed_by_name}${p.sign_method ? ` (${METHOD_WORDS[p.sign_method].toLowerCase()})` : ''}` }] : []),
                  ...(p.decline_reason ? [{ term: 'Declined', value: p.decline_reason }] : []),
                ]} />
              )}
            </Section>
          )}
        </div>
        <aside className="stack" aria-label="Totals">
          <Section title="Price">
            {mv.contract ? (
              <KV items={[
                { term: 'Base scope', value: money(p.base_price_cents) },
                ...(p.options_price_cents ? [{ term: 'Chosen options', value: money(p.options_price_cents) }] : []),
                ...(p.allowance_cents ? [{ term: 'Allowances (in base)', value: money(p.allowance_cents) }] : []),
                ...(p.contingency_cents ? [{ term: `Contingency${p.contingency_pct ? ` ${pct(p.contingency_pct)}` : ''}`, value: money(p.contingency_cents) }] : []),
                ...(p.fee_total_cents ? [{ term: 'Builder fee', value: money(p.fee_total_cents) }] : []),
                { term: 'Contract price', value: <span className="b">{money(p.total_cents)}</span> },
                ...(p.tax_cents ? [{ term: 'Sales tax', value: money(p.tax_cents) }, { term: 'With tax', value: <span className="b">{money(p.grand_total_cents)}</span> }] : []),
                ...(p.deposit_due_cents ? [{ term: 'Deposit at signing', value: money(p.deposit_due_cents) }] : []),
                ...(p.retainer_credit_cents ? [{ term: 'Design retainer credit', value: money(-p.retainer_credit_cents) }] : []),
              ]} />
            ) : <p className="t-cap">Prices are hidden for your role.</p>}
          </Section>
          {mv.cost && (
            <Section title="Cost" meta="Not shown to the homeowner">
              <KV items={[
                { term: 'Cost (budget)', value: p.cost_cents == null ? '—' : money(p.cost_cents) },
                { term: 'Overhead recovered', value: p.overhead_cents == null ? '—' : money(p.overhead_cents) },
                ...(p.use_tax_cents ? [{ term: 'Use tax on materials', value: money(p.use_tax_cents) }] : []),
                { term: 'Margin', value: margin == null ? '—' : <span className={margin < 0.15 ? 'neg b' : undefined}>{pct(margin)}</span> },
              ]} />
              {margin != null && margin < 0.15 && <p className="t-cap" style={{ marginTop: 6 }}>Under the 15% floor: sending asks Approvals first.</p>}
            </Section>
          )}
          {p.cancellation_notice && (
            <Section title="Right to cancel" meta={`${p.cancel_days ?? 3} business days${p.state_code ? ` · ${p.state_code}` : ''}`}>
              <p className="t-cap">{p.cancellation_notice}</p>
            </Section>
          )}
        </aside>
      </div>

      {dialog === 'accept' && <AcceptDialog url={url} onClose={() => setDialog(null)} />}
      {dialog === 'sign' && <SignDialog url={url} customer={b.job?.customer_name ?? ''} onClose={() => setDialog(null)} />}
      {dialog === 'decline' && <DeclineDialog url={url} onClose={() => setDialog(null)} />}
    </div>
  );
}

function AcceptDialog({ url, onClose }: { url: string; onClose: () => void }) {
  const { act, busy, error } = useOps();
  const [name, setName] = useState('');
  const [method, setMethod] = useState<'IN_PERSON' | 'PHONE' | 'EMAIL' | 'PORTAL'>('IN_PERSON');
  const go = async () => {
    if (!name.trim()) return;
    const r = await act('accept', 'post', url, { op: 'accept', signerName: name.trim(), method }, 'Accepted — the job is built');
    if (r) onClose();
  };
  return (
    <Dialog open onClose={onClose} title="Accept and build the job" dismissOnScrim={false}
      footNote="Creates the contract, baseline budget (cost, no overhead), schedule, payment milestones, deposit request, selections and portal invites."
      actions={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim() || busy === 'accept'} onClick={() => void go()}>Accept</Button></>}>
      <div className="mp-form">
        <Field label="Homeowner who accepted"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus placeholder="Full name" /></Field>
        <Field label="How">
          <Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            {(['IN_PERSON', 'PHONE', 'EMAIL', 'PORTAL'] as const).map((m) => <option key={m} value={m}>{METHOD_WORDS[m]}</option>)}
          </Select>
        </Field>
        <Failure text={error} />
      </div>
    </Dialog>
  );
}

interface SignerDraft { name: string; email: string; phone: string }

function SignDialog({ url, customer, onClose }: { url: string; customer: string; onClose: () => void }) {
  const { act, busy, error } = useOps();
  const [signers, setSigners] = useState<SignerDraft[]>([{ name: customer, email: '', phone: '' }]);
  const [message, setMessage] = useState('');
  const set = (i: number, k: keyof SignerDraft, v: string) => setSigners((s) => s.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const ready = signers.every((s) => s.name.trim() && (s.email.trim() || s.phone.trim()));
  const go = async () => {
    const r = await act('sign', 'post', url, {
      op: 'sign', message: message.trim() || undefined,
      signers: signers.map((s, i) => ({ name: s.name.trim(), email: s.email.trim() || null, phone: s.phone.trim() || null, roleLabel: 'Homeowner', order: i + 1 })),
    }, 'Signature request sent');
    if (r) onClose();
  };
  return (
    <Dialog open onClose={onClose} title="Request e-signature" width={600} dismissOnScrim={false}
      footNote="Both owners sign in parallel. When the last one signs, the job is built automatically."
      actions={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ready || busy === 'sign'} onClick={() => void go()}>Send</Button></>}>
      <div className="mp-form">
        {signers.map((s, i) => (
          <div key={i} className="mp-form-2">
            <Field label={`Signer ${i + 1}`}><Input value={s.name} onChange={(e) => set(i, 'name', e.target.value)} maxLength={120} placeholder="Name" /></Field>
            <Field label="Email or mobile">
              <div className="row" style={{ gap: 6 }}>
                <Input type="email" value={s.email} onChange={(e) => set(i, 'email', e.target.value)} placeholder="Email" aria-label={`Signer ${i + 1} email`} />
                <Input type="tel" value={s.phone} onChange={(e) => set(i, 'phone', e.target.value)} placeholder="Mobile" aria-label={`Signer ${i + 1} mobile`} />
              </div>
            </Field>
          </div>
        ))}
        {signers.length < 2 && <Button variant="quiet" icon="plus" onClick={() => setSigners((s) => [...s, { name: '', email: '', phone: '' }])}>Add a second owner</Button>}
        <Field label="Message"><Textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} /></Field>
        <Failure text={error} />
      </div>
    </Dialog>
  );
}

function DeclineDialog({ url, onClose }: { url: string; onClose: () => void }) {
  const { act, busy, error } = useOps();
  const [reason, setReason] = useState('');
  const go = async () => {
    const r = await act('decline', 'post', url, { op: 'decline', reason: reason.trim() || null }, 'Marked declined');
    if (r) onClose();
  };
  return (
    <Dialog open onClose={onClose} title="The homeowner declined" role="alertdialog"
      actions={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy === 'decline'} onClick={() => void go()}>Mark declined</Button></>}>
      <div className="mp-form">
        <Field label="Why (for win / loss)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} autoFocus placeholder="Price, timing, went with another builder…" /></Field>
        <Failure text={error} />
      </div>
    </Dialog>
  );
}
