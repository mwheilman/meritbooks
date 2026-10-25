'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, Check, Drawer, Field, Input, InlineNotice, MoneyInput, Seg, Select, Tag, Textarea, money } from '@meritbooks/merit-ui';
import { STANDARD_EXCLUSIONS } from '@/lib/commercial/screen-schemas';
import type { TradeProposal } from '@/lib/commercial/screen-types';
import { useMoneyVis, useShell } from '@/components/shell/ShellContext';
import { useOps } from '@/components/ops/common/useOps';
import { DSection, Failure, cm, day, daysSince } from './common';
import { CmTable, TableKeys, words, type Col } from './kit';

type Act = ReturnType<typeof useOps>['act'];
type Tab = 'open' | 'won' | 'all';
const lines = (s: string) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

/** Base bid plus the alternates the GC took (index list), in cents. Pure. */
export function proposalTotal(p: Pick<TradeProposal, 'base_bid_cents' | 'alternates'>, accepted: ReadonlyArray<number>): number {
  return Number(p.base_bid_cents ?? 0) + p.alternates.reduce((s, a, i) => s + (accepted.includes(i) ? Number(a.amount_cents) : 0), 0);
}

/**
 * Trade proposals to GCs (CGC-25): base bid, alternates, unit prices, inclusions, exclusions,
 * qualifications, schedule assumptions and how long the price holds. Sent proposals are locked;
 * an accepted one becomes the job, with the prime contract at base bid plus the alternates taken.
 */
export function TradeProposalsView({ proposals, customers, companies, jobTypes, today, canEdit, canAccept }: {
  proposals: TradeProposal[]; customers: Array<{ id: string; name: string }>; companies: Array<{ id: string; name: string }>;
  jobTypes: Array<{ companyId: string; key: string; label: string }>; today: string; canEdit: boolean; canAccept: boolean;
}) {
  const { readOnly } = useShell();
  const mv = useMoneyVis();
  const { act, busy, error } = useOps();
  const [tab, setTab] = useState<Tab>('open');
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const cust = useMemo(() => new Map(customers.map((c) => [c.id, c.name])), [customers]);
  const shown = proposals.filter((p) => tab === 'all' || (tab === 'open' ? p.status === 'DRAFT' || p.status === 'SENT' : p.status === 'ACCEPTED'));
  const open = proposals.find((p) => p.id === openId) ?? null;
  const out = proposals.filter((p) => p.status === 'SENT');
  const edit = !readOnly && canEdit;

  const cols: Col<TradeProposal>[] = [
    { key: 'no', head: 'Number', width: 150, cell: (p) => <span className="code">{p.number ?? '—'}</span> },
    { key: 'p', head: 'Project', cell: (p) => <><span className="b">{p.project_name}</span><span className="ops-sub" style={{ display: 'block' }}>{p.customer_id ? cust.get(p.customer_id) ?? 'GC' : 'No GC picked'}</span></> },
    { key: 'base', head: 'Base bid', n: true, width: 130, hidden: !mv.contract, cell: (p) => cm(p.base_bid_cents, 0) },
    { key: 'alts', head: 'Alternates', width: 110, cell: (p) => (p.alternates.length ? `${p.alternates.length}` : '—') },
    { key: 'valid', head: 'Price holds to', width: 150, cell: (p) => { const d = daysSince(p.valid_until, today); return <>{day(p.valid_until, today)}{p.status === 'SENT' && d != null && d > -7 && <span style={{ display: 'block' }}><Tag tone={d > 0 ? 'neg' : 'warn'}>{d > 0 ? 'Expired' : 'Expiring'}</Tag></span>}</>; } },
    { key: 's', head: 'Status', width: 140, cell: (p) => (p.status === 'ACCEPTED' ? <Tag tone="pos">Accepted</Tag> : p.status === 'DECLINED' || p.status === 'EXPIRED' ? <Tag tone="neg">{words(p.status)}</Tag> : <Tag>{p.status === 'SENT' ? 'With the GC' : 'Draft'}</Tag>) },
  ];

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="ops-toolbar">
        <Seg aria-label="Which proposals" value={tab} onChange={setTab} items={[
          { value: 'open', label: 'Open', count: proposals.filter((p) => p.status === 'DRAFT' || p.status === 'SENT').length },
          { value: 'won', label: 'Accepted', count: proposals.filter((p) => p.status === 'ACCEPTED').length }, { value: 'all', label: 'All' },
        ]} />
        <span className="sp" />
        {mv.contract && out.length > 0 && <span className="t-cap">{out.length} with GCs · {money(out.reduce((s, p) => s + Number(p.base_bid_cents ?? 0), 0), { decimals: 0 })} base</span>}
        {edit && <Button variant="primary" icon="plus" chord="n" bindChord onClick={() => setAdding((v) => !v)}>New proposal</Button>}
      </div>
      <Failure text={error} />
      {adding && edit && <NewProposal companies={companies} customers={customers} busy={busy} act={act} onDone={(id) => { setAdding(false); if (id) setOpenId(id); }} />}
      <CmTable label="Trade proposals" keys rows={shown} cols={cols} rowKey={(p) => p.id} onOpen={(p) => setOpenId(p.id)} activeId={openId}
        rowTone={(p) => (p.status === 'SENT' && p.valid_until && p.valid_until < today ? 'neg' : null)}
        empty={{ title: tab === 'won' ? 'No accepted proposals yet' : 'No open proposals', body: 'Price the trade package for the GC: base bid, alternates, unit prices, what is in and what is not, and how long the price holds.' }} />
      <TableKeys extra={edit ? [{ chord: 'n', label: 'New proposal' }] : []} />
      <Drawer open={!!open} onClose={() => setOpenId(null)} width={680} title={open ? `${open.number ?? 'Proposal'} · ${open.project_name}` : ''} eyebrow={open?.customer_id ? cust.get(open.customer_id) : 'Trade proposal'}>
        {open && <ProposalDetail key={`${open.id}:${open.status}`} p={open} customers={customers} jobTypes={jobTypes.filter((j) => j.companyId === open.location_id)} today={today}
          edit={edit && open.status === 'DRAFT'} canSend={edit && (open.status === 'DRAFT' || open.status === 'SENT')} canAccept={!readOnly && canAccept && (open.status === 'SENT' || open.status === 'DRAFT')} busy={busy} act={act} showMoney={mv.contract} />}
      </Drawer>
    </div>
  );
}

function NewProposal({ companies, customers, busy, act, onDone }: { companies: Array<{ id: string; name: string }>; customers: Array<{ id: string; name: string }>; busy: string | null; act: Act; onDone: (id: string | null) => void }) {
  const [companyId, setCompanyId] = useState(companies[0]?.id ?? '');
  const [customerId, setCustomerId] = useState('');
  const [name, setName] = useState('');
  const [base, setBase] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="mp-table mp-add" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }} onSubmit={async (e) => {
      e.preventDefault();
      if (!companyId || !name.trim()) return setErr('Name the project.');
      setErr(null);
      const r = await act<{ id: string; number: string }>('new', 'post', '/api/commercial/proposals/drafts', { companyId, customerId: customerId || null, projectName: name.trim(), baseBidCents: base ?? 0 }, (d) => `Started ${d.number}`);
      onDone(r?.id ?? null);
    }}>
      {companies.length > 1 && <Field label="Company"><Select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>}
      <Field label="GC"><Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}><option value="">Pick later</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
      <Field label="Project" error={err ?? undefined}><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="Mercy West tower — electrical" style={{ width: 280 }} /></Field>
      <Field label="Base bid"><MoneyInput valueCents={base} onChangeCents={setBase} /></Field>
      <Button type="submit" variant="primary" disabled={busy !== null}>{busy === 'new' ? 'Starting…' : 'Start the proposal'}</Button>
    </form>
  );
}

function ProposalDetail({ p, customers, jobTypes, today, edit, canSend, canAccept, busy, act, showMoney }: {
  p: TradeProposal; customers: Array<{ id: string; name: string }>; jobTypes: Array<{ key: string; label: string }>; today: string;
  edit: boolean; canSend: boolean; canAccept: boolean; busy: string | null; act: Act; showMoney: boolean;
}) {
  const url = `/api/commercial/proposals/${p.id}`;
  const [customerId, setCustomerId] = useState(p.customer_id ?? '');
  const [name, setName] = useState(p.project_name);
  const [base, setBase] = useState<number | null>(p.base_bid_cents);
  const [alts, setAlts] = useState(p.alternates.map((a) => ({ label: a.label, amount_cents: Number(a.amount_cents ?? 0) })));
  const [units, setUnits] = useState(p.unit_prices.map((u) => ({ ...u })));
  const [inc, setInc] = useState(p.inclusions.join('\n'));
  const [exc, setExc] = useState(p.exclusions.join('\n'));
  const [qual, setQual] = useState(p.qualifications.join('\n'));
  const [sched, setSched] = useState(p.schedule_assumptions ?? '');
  const [valid, setValid] = useState(p.valid_until ?? '');
  const [trade, setTrade] = useState('GENERAL');
  const [jobType, setJobType] = useState(jobTypes[0]?.key ?? '');
  const [taken, setTaken] = useState<number[]>([]);
  const expired = !!p.valid_until && p.valid_until < today;
  // money fields go back only when the caller sees them (masked amounts are null — never write them back as zero)
  const body = () => ({
    customerId: customerId || null, projectName: name.trim(),
    ...(showMoney ? { baseBidCents: base ?? 0, alternates: alts.filter((a) => a.label.trim()), unitPrices: units.filter((u) => u.item.trim() && u.uom.trim()) } : {}),
    inclusions: lines(inc), exclusions: lines(exc), qualifications: lines(qual), scheduleAssumptions: sched.trim() || null, validUntil: valid || null,
  });

  return (
    <div className="stack" style={{ gap: 20 }}>
      {p.status === 'ACCEPTED' && p.job_id && <InlineNotice tone="info" title="Accepted — this is now a job."><Link className="link" href={`/jobs/${p.job_id}`}>Open the job</Link></InlineNotice>}
      {p.status === 'SENT' && <InlineNotice tone={expired ? 'neg' : 'default'} title={expired ? 'The price has expired.' : 'With the GC.'}>Sent {p.sent_at?.slice(0, 10) ?? ''}. A sent proposal is locked; revise by starting a new one.</InlineNotice>}
      {edit ? (
        <>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field label="Project"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} style={{ width: 260 }} /></Field>
            <Field label="GC"><Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}><option value="">Pick the GC</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
            {showMoney && <Field label="Base bid"><MoneyInput valueCents={base} onChangeCents={setBase} /></Field>}
            <Field label="Price holds to" help="Blank: 30 days from sending"><Input type="date" value={valid} onChange={(e) => setValid(e.target.value)} /></Field>
          </div>
          {showMoney && (
            <DSection title="Alternates" aside={<Button variant="quiet" onClick={() => setAlts((a) => [...a, { label: '', amount_cents: 0 }])}>Add alternate</Button>}>
              {alts.length === 0 ? <p className="t-cap">None.</p> : alts.map((a, i) => (
                <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-end', marginBottom: 6 }}>
                  <Field label={`Alternate ${i + 1}`}><Input value={a.label} onChange={(e) => setAlts((x) => x.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} maxLength={200} style={{ width: 300 }} /></Field>
                  <Field label="Add / (deduct)"><MoneyInput allowNegative valueCents={a.amount_cents} onChangeCents={(c) => setAlts((x) => x.map((y, j) => (j === i ? { ...y, amount_cents: c ?? 0 } : y)))} /></Field>
                  <Button variant="quiet" onClick={() => setAlts((x) => x.filter((_, j) => j !== i))}>Remove</Button>
                </div>
              ))}
            </DSection>
          )}
          {showMoney && (
            <DSection title="Unit prices" aside={<Button variant="quiet" onClick={() => setUnits((u) => [...u, { item: '', uom: 'EA', unit_cents: 0 }])}>Add unit price</Button>}>
              {units.length === 0 ? <p className="t-cap">None.</p> : units.map((u, i) => (
                <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-end', marginBottom: 6 }}>
                  <Field label="Item"><Input value={u.item} onChange={(e) => setUnits((x) => x.map((y, j) => (j === i ? { ...y, item: e.target.value } : y)))} maxLength={200} style={{ width: 240 }} /></Field>
                  <Field label="Unit"><Input value={u.uom} onChange={(e) => setUnits((x) => x.map((y, j) => (j === i ? { ...y, uom: e.target.value } : y)))} maxLength={20} style={{ width: 70 }} /></Field>
                  <Field label="Price per unit"><MoneyInput valueCents={u.unit_cents} onChangeCents={(c) => setUnits((x) => x.map((y, j) => (j === i ? { ...y, unit_cents: c ?? 0 } : y)))} /></Field>
                  <Button variant="quiet" onClick={() => setUnits((x) => x.filter((_, j) => j !== i))}>Remove</Button>
                </div>
              ))}
            </DSection>
          )}
          <Field label="Inclusions" help="One per line."><Textarea value={inc} onChange={(e) => setInc(e.target.value)} rows={4} /></Field>
          <Field label="Exclusions" help="One per line.">
            <Textarea value={exc} onChange={(e) => setExc(e.target.value)} rows={5} />
          </Field>
          <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
            <Field label="Standard exclusions for"><Select value={trade} onChange={(e) => setTrade(e.target.value)}>{Object.keys(STANDARD_EXCLUSIONS).map((k) => <option key={k} value={k}>{words(k)}</option>)}</Select></Field>
            <Button variant="quiet" onClick={() => setExc((x) => [...new Set([...lines(x), ...(STANDARD_EXCLUSIONS[trade] ?? [])])].join('\n'))}>Add them</Button>
          </div>
          <Field label="Qualifications" help="One per line."><Textarea value={qual} onChange={(e) => setQual(e.target.value)} rows={3} /></Field>
          <Field label="Schedule assumptions"><Textarea value={sched} onChange={(e) => setSched(e.target.value)} maxLength={2000} placeholder="Two mobilizations; area by area as released; normal hours" /></Field>
          <div className="row" style={{ gap: 8 }}>
            <Button chord="mod+s" bindChord disabled={busy !== null || !name.trim()} onClick={() => void act('save', 'patch', url, body(), 'Saved the proposal')}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
            {canSend && <Button variant="primary" disabled={busy !== null || !(base && base > 0)} onClick={async () => { const s = await act('save', 'patch', url, body(), () => null); if (s) await act('send', 'post', '/api/commercial/proposals', { op: 'send', proposalId: p.id, envelopeId: null }, 'Sent the proposal'); }}>{busy === 'send' ? 'Sending…' : 'Save and send'}</Button>}
          </div>
        </>
      ) : (
        <ProposalSheet p={p} customer={customers.find((c) => c.id === p.customer_id)?.name ?? null} showMoney={showMoney} />
      )}
      {canAccept && (
        <DSection title="The GC accepted">
          <div className="stack" style={{ gap: 8 }}>
            {p.alternates.length > 0 && (
              <div className="stack" style={{ gap: 4 }}>
                {p.alternates.map((a, i) => <Check key={i} label={`${a.label}${showMoney ? ` (${money(Number(a.amount_cents), { decimals: 0 })})` : ''}`} checked={taken.includes(i)} onChange={(e) => setTaken((t) => (e.target.checked ? [...t, i] : t.filter((x) => x !== i)))} />)}
              </div>
            )}
            {showMoney && <p className="t-cap">Contract: {money(proposalTotal(p, taken), { decimals: 0 })}</p>}
            <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
              <Field label="Start it as"><Select value={jobType} onChange={(e) => setJobType(e.target.value)}>{jobTypes.map((j) => <option key={j.key} value={j.key}>{j.label}</option>)}</Select></Field>
              <Button variant="primary" disabled={busy !== null || !jobType || expired} onClick={() => void act<{ jobId: string }>('accept', 'post', '/api/commercial/proposals', { op: 'accept', proposalId: p.id, jobTypeKey: jobType, alternates: taken.map((i) => i + 1) }, 'Accepted — the job is set up')}>
                {busy === 'accept' ? 'Setting up…' : 'Accept and create the job'}
              </Button>
            </div>
            {expired && <p className="t-cap">The price expired {p.valid_until}. Re-price with a new proposal.</p>}
          </div>
        </DSection>
      )}
    </div>
  );
}

/** The proposal as the GC reads it (also what prints). */
export function ProposalSheet({ p, customer, showMoney }: { p: TradeProposal; customer: string | null; showMoney: boolean }) {
  const list = (title: string, xs: string[]) => xs.length > 0 && <DSection title={title}><ul style={{ paddingLeft: 18 }}>{xs.map((x, i) => <li key={i}>{x}</li>)}</ul></DSection>;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="ops-facts">
        <span>To <b>{customer ?? '—'}</b></span>
        {showMoney && <span>Base bid <b className="tnum">{cm(p.base_bid_cents)}</b></span>}
        <span>Price holds to <b>{p.valid_until ?? '30 days from sending'}</b></span>
      </div>
      {p.alternates.length > 0 && (
        <DSection title="Alternates">
          <ul className="feed">{p.alternates.map((a, i) => <li key={i}><span>{i + 1}. {a.label}{a.accepted ? <> <Tag tone="pos">Taken</Tag></> : null}</span>{showMoney && <span className="t tnum">{money(Number(a.amount_cents))}</span>}</li>)}</ul>
        </DSection>
      )}
      {p.unit_prices.length > 0 && showMoney && (
        <DSection title="Unit prices"><ul className="feed">{p.unit_prices.map((u, i) => <li key={i}><span>{u.item}</span><span className="t tnum">{money(Number(u.unit_cents))} / {u.uom}</span></li>)}</ul></DSection>
      )}
      {list('Inclusions', p.inclusions)}
      {list('Exclusions', p.exclusions)}
      {list('Qualifications', p.qualifications)}
      {p.schedule_assumptions && <DSection title="Schedule assumptions"><p style={{ whiteSpace: 'pre-wrap' }}>{p.schedule_assumptions}</p></DSection>}
      <div className="ops-noprint"><Button variant="quiet" onClick={() => window.print()}>Print</Button></div>
    </div>
  );
}
