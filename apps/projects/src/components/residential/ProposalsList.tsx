'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Bands, Button, Field, Input, Panel, PanelSection, QueueTable, Select, WidgetState, count, money, shortDate, useEscapeKey,
  type QueueColumn,
} from '@meritbooks/merit-ui';
import type { JobOption } from '@/lib/pm/ops/scope';
import type { OpenLead, ProposalListItem } from '@/lib/residential/queries';
import { CONTRACT_SHORT, PROPOSAL_STATUS } from '@/lib/residential/labels';
import { useMoneyVis, useShell } from '@/components/shell/ShellContext';
import { when } from '@/components/money/visibility';
import { Failure, JobSelect, StatusMark } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';

type Band = 'open' | 'sent' | 'won' | 'all';

export interface ProposalsListProps {
  rows: ProposalListItem[];
  leads: OpenLead[];
  jobs: JobOption[];
  companies: Array<{ id: string; name: string }>;
  today: string;
  canCreate: boolean;
}

export function ProposalsList(p: ProposalsListProps) {
  const router = useRouter();
  const mv = useMoneyVis();
  const { readOnly } = useShell();
  const [band, setBand] = useState<Band>('open');
  const [creating, setCreating] = useState(false);
  const inBand = (b: Band) => p.rows.filter((r) => (b === 'open' ? r.status === 'DRAFT' : b === 'sent' ? r.status === 'SENT' : b === 'won' ? r.status === 'ACCEPTED' : true));
  const rows = inBand(band);
  const sentValue = inBand('sent').reduce((s, r) => s + r.total_cents, 0);
  const unseen = inBand('sent').filter((r) => r.view_count === 0).length;
  const columns: QueueColumn<ProposalListItem>[] = [
    { id: 'what', header: 'Proposal', cell: (r) => <><span className="l1">{r.title}{r.version > 1 ? ` · v${r.version}` : ''}</span><span className="l2">{[r.number, r.customer_name, r.job_number].filter(Boolean).join(' · ')}</span></> },
    { id: 'form', header: 'Contract', width: 150, cell: (r) => CONTRACT_SHORT[r.contract_type] },
    ...when<QueueColumn<ProposalListItem>>(mv.contract, { id: 'total', header: 'Price', numeric: true, width: 130, cell: (r) => money(r.grand_total_cents || r.total_cents) }),
    { id: 'seen', header: 'Viewed', width: 140, cell: (r) => (r.status !== 'SENT' ? '—' : r.view_count === 0 ? <span className="b">Not opened</span> : `${count(r.view_count)}× · ${r.last_viewed_at ? shortDate(r.last_viewed_at.slice(0, 10), p.today) : ''}`) },
    { id: 'valid', header: 'Valid until', width: 110, cell: (r) => (r.valid_until ? <span className={r.status === 'SENT' && r.valid_until < p.today ? 'neg b' : undefined}>{shortDate(r.valid_until, p.today)}</span> : '—') },
    { id: 'st', header: 'Status', width: 140, cell: (r) => <StatusMark mark={PROPOSAL_STATUS[r.status]} /> },
  ];
  const open = (r: ProposalListItem) => router.push(`/proposals/${r.id}`);

  return (
    <div className="stack">
      <div className="ops-toolbar">
        <div style={{ flex: 1, maxWidth: 760 }}>
          <Bands<Band> aria-label="Proposals by status" value={band} onChange={setBand} items={[
            { value: 'open', label: 'Drafts', count: count(inBand('open').length), caption: 'Being priced' },
            { value: 'sent', label: 'Out for signature', count: count(inBand('sent').length), caption: mv.contract ? `${money(sentValue)}${unseen ? ` · ${count(unseen)} not opened` : ''}` : unseen ? `${count(unseen)} not opened` : 'Sent' },
            { value: 'won', label: 'Accepted', count: count(inBand('won').length), caption: 'Became jobs' },
            { value: 'all', label: 'All', count: count(p.rows.length) },
          ]} />
        </div>
        <span className="sp" />
        {!readOnly && p.canCreate && <Button variant="primary" icon="plus" chord="n" bindChord={!creating} onClick={() => setCreating(true)}>New proposal</Button>}
      </div>
      <div className={creating ? 'ops-split has-panel' : 'ops-split'}>
        <div className="mp-table" style={{ minWidth: 0 }}>
          {rows.length === 0 ? (
            <WidgetState state={p.rows.length === 0
              ? { kind: 'empty', title: 'No proposals yet', body: 'Start one from a lead or a job: price it from the catalog, add good / better / best options and allowances, set the payment schedule, and send it to sign. Accepting it builds the job.', action: readOnly || !p.canCreate ? undefined : <Button variant="primary" onClick={() => setCreating(true)}>New proposal</Button> }
              : { kind: 'done', title: band === 'sent' ? 'Nothing is out for signature' : band === 'open' ? 'No drafts' : 'Nothing accepted yet', body: 'Switch the band above to see the others.' }} />
          ) : (
            <QueueTable aria-label="Proposals" columns={columns} rows={rows} getRowId={(r) => r.id} onOpen={open} openOnClick
              rowState={(r) => ({ done: r.status === 'DECLINED', attn: r.status === 'SENT' && !!r.valid_until && r.valid_until < p.today })} />
          )}
        </div>
        {creating && <NewProposalPanel leads={p.leads} jobs={p.jobs.filter((j) => j.open)} companies={p.companies} onClose={() => setCreating(false)} onCreated={(id) => router.push(`/proposals/${id}`)} />}
      </div>
    </div>
  );
}

function NewProposalPanel({ leads, jobs, companies, onClose, onCreated }: { leads: OpenLead[]; jobs: JobOption[]; companies: Array<{ id: string; name: string }>; onClose: () => void; onCreated: (id: string) => void }) {
  const { act, busy, error } = useOps();
  const [from, setFrom] = useState<'lead' | 'job'>(leads.length ? 'lead' : 'job');
  const [leadId, setLeadId] = useState('');
  const [jobId, setJobId] = useState('');
  const [title, setTitle] = useState('');
  const [contract, setContract] = useState<keyof typeof CONTRACT_SHORT>('FIXED_PRICE');
  const [err, setErr] = useState<string | null>(null);
  useEscapeKey(onClose, busy !== 'create', 'New proposal');
  const leadCompany = useMemo(() => new Map(leads.map((l) => [l.id, l.location_id])), [leads]);
  const names = useMemo(() => new Map(companies.map((c) => [c.id, c.name])), [companies]);
  const submit = async () => {
    if (from === 'lead' && !leadId) return setErr('Pick the lead.');
    if (from === 'job' && !jobId) return setErr('Pick the job.');
    setErr(null);
    const body = from === 'lead'
      ? { leadId, companyId: leadCompany.get(leadId) ?? null, title: title.trim() || null, attrs: { contractType: contract } }
      : { jobId, title: title.trim() || null, attrs: { contractType: contract } };
    const r = await act<{ proposalId: string }>('create', 'post', '/api/residential/proposals', body, 'Proposal started');
    if (r) onCreated(r.proposalId);
  };
  return (
    <Panel eyebrow={['New', 'Proposal']} title={title.trim() || 'New proposal'} meta={from === 'lead' ? 'Makes the presale job and the customer from the lead' : 'On the existing job'} onClose={onClose}
      foot={<div className="btn-row" style={{ justifyContent: 'flex-end', width: '100%' }}><Button onClick={onClose}>Cancel</Button><Button variant="primary" chord="mod+enter" bindChord disabled={busy === 'create'} onClick={() => void submit()}>Start proposal</Button></div>}>
      <PanelSection>
        <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <Field label="Start from">
            <Select value={from} onChange={(e) => setFrom(e.target.value as 'lead' | 'job')}>
              <option value="lead" disabled={!leads.length}>A lead{leads.length ? '' : ' (no open leads)'}</option>
              <option value="job">A job (design → build, or a new phase)</option>
            </Select>
          </Field>
          {from === 'lead' ? (
            <Field label="Lead" error={err ?? undefined}>
              <Select value={leadId} onChange={(e) => setLeadId(e.target.value)} autoFocus>
                <option value="">Pick a lead</option>
                {leads.map((l) => <option key={l.id} value={l.id}>{l.title}{companies.length > 1 ? ` · ${names.get(l.location_id) ?? ''}` : ''}{l.estimated_value_cents ? ` · ${money(l.estimated_value_cents)}` : ''}</option>)}
              </Select>
            </Field>
          ) : (
            <Field label="Job" error={err ?? undefined}><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>
          )}
          <Field label="Title" help="Shown to the homeowner"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Kitchen remodel" maxLength={200} /></Field>
          <Field label="Contract form">
            <Select value={contract} onChange={(e) => setContract(e.target.value as keyof typeof CONTRACT_SHORT)}>
              {(['FIXED_PRICE', 'COST_PLUS_PCT', 'COST_PLUS_FEE', 'COST_PLUS_GMP', 'TIME_MATERIALS', 'DESIGN_AGREEMENT'] as const).map((k) => <option key={k} value={k}>{CONTRACT_SHORT[k]}</option>)}
            </Select>
          </Field>
          <Failure text={error} />
          <button type="submit" hidden />
        </form>
      </PanelSection>
    </Panel>
  );
}
