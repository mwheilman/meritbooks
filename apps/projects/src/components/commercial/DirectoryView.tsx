'use client';

import { useMemo, useState } from 'react';
import { Button, Check, ConfirmDialog, Drawer, Field, Input, KV, MoneyInput, Search, Select, Tabs, Tag, Textarea } from '@meritbooks/merit-ui';
import { PARTY_ROLES } from '@/lib/commercial/screen-schemas';
import { divisionName } from '@/lib/commercial/screen-logic';
import type { CompanyProfile, DirectoryEntry } from '@/lib/commercial/screen-types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useMoneyVis, useShell } from '@/components/shell/ShellContext';
import { JobSelect } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';
import { DSection, Failure, cm, day } from './common';
import { CmTable, TableKeys, words, type Col } from './kit';

type Tab = 'directory' | 'trades';
type Act = ReturnType<typeof useOps>['act'];
const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** Who to tell: the email list for a distribution group on a job (deduped, entries without email left out). Pure. */
export function groupEmails(entries: ReadonlyArray<DirectoryEntry>, group: string | null): string[] {
  return [...new Set(entries.filter((e) => e.email && (!group || (e.distribution_groups ?? []).includes(group))).map((e) => e.email!.toLowerCase()))];
}

/**
 * The project directory with trade data (CGC-04): companies and contacts from the shared customer
 * and vendor master (never copied), with trade, CSI divisions, licenses, union local, DBE / MBE /
 * WBE status, EMR and prequalification, and the job's distribution groups.
 */
export function DirectoryView({ entries, profiles, vendors, jobs, today, canEdit, canEditProfiles, initialJob }: {
  entries: DirectoryEntry[]; profiles: CompanyProfile[]; vendors: Array<{ id: string; name: string }>; jobs: JobOption[]; today: string;
  canEdit: boolean; canEditProfiles: boolean; initialJob?: string | null;
}) {
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const [tab, setTab] = useState<Tab>('directory');
  const [jobId, setJobId] = useState(initialJob ?? '');
  const [role, setRole] = useState('');
  const [group, setGroup] = useState('');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [profileFor, setProfileFor] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const byJob = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const vendorName = useMemo(() => new Map(vendors.map((v) => [v.id, v.name])), [vendors]);
  const profileOf = useMemo(() => new Map(profiles.filter((p) => p.vendor_id).map((p) => [p.vendor_id!, p])), [profiles]);
  const needle = q.trim().toLowerCase();
  const inJob = entries.filter((e) => !jobId || e.job_id === jobId);
  const groups = [...new Set(inJob.flatMap((e) => e.distribution_groups ?? []))].sort();
  const shown = inJob.filter((e) => (!role || e.party_role === role) && (!group || (e.distribution_groups ?? []).includes(group)) &&
    (!needle || `${e.company_name ?? ''} ${e.contact_name ?? ''} ${e.trade ?? ''} ${e.email ?? ''} ${(e.csi_divisions ?? []).join(' ')}`.toLowerCase().includes(needle)));
  const emails = groupEmails(shown, group || null);
  const open = entries.find((e) => e.directory_id === openId) ?? null;
  const edit = !readOnly && canEdit;

  const cols: Col<DirectoryEntry>[] = [
    { key: 'co', head: 'Company', cell: (e) => <><span className="b">{e.company_name ?? '—'}</span>{e.is_primary && <> <Tag>Primary</Tag></>}<span className="ops-sub" style={{ display: 'block' }}>{[words(e.party_role), !jobId ? byJob.get(e.job_id)?.label : null].filter(Boolean).join(' · ')}</span></> },
    { key: 'who', head: 'Contact', width: 220, cell: (e) => <>{e.contact_name ?? '—'}{(e.email || e.phone) && <span className="ops-sub" style={{ display: 'block' }}>{[e.email, e.phone].filter(Boolean).join(' · ')}</span>}</> },
    { key: 'trade', head: 'Trade and divisions', width: 220, cell: (e) => <>{e.trade ?? '—'}{(e.csi_divisions ?? []).length > 0 && <span className="ops-sub" style={{ display: 'block' }}>Div {(e.csi_divisions ?? []).join(', ')}</span>}</> },
    { key: 'cert', head: 'Certifications', width: 170, cell: (e) => <>{[e.dbe && 'DBE', e.mbe && 'MBE', e.wbe && 'WBE'].filter(Boolean).map((x) => <Tag key={String(x)}>{x}</Tag>)}{e.union_local && <span className="ops-sub" style={{ display: 'block' }}>{e.union_local}</span>}{!e.dbe && !e.mbe && !e.wbe && !e.union_local && '—'}</> },
    { key: 'emr', head: 'EMR', n: true, width: 70, cell: (e) => (e.emr == null ? '—' : <span className={Number(e.emr) > 1 ? 'neg' : undefined}>{Number(e.emr).toFixed(2)}</span>) },
    { key: 'pq', head: 'Prequal', width: 130, cell: (e) => (!e.prequal_status || e.prequal_status === 'NONE' ? '—' : <><Tag tone={e.prequal_status === 'QUALIFIED' ? 'pos' : e.prequal_status === 'DISQUALIFIED' || e.prequal_status === 'EXPIRED' ? 'neg' : undefined}>{words(e.prequal_status)}</Tag>{e.prequal_expires && <span className="ops-sub" style={{ display: 'block' }}>to {day(e.prequal_expires, today)}</span>}</>) },
  ];
  const tradeRows = vendors.filter((v) => profileOf.has(v.id) || entries.some((e) => e.vendor_id === v.id))
    .filter((v) => !needle || `${v.name} ${(profileOf.get(v.id)?.trades ?? []).join(' ')}`.toLowerCase().includes(needle));
  const tcols: Col<{ id: string; name: string }>[] = [
    { key: 'v', head: 'Company', cell: (v) => <span className="b">{v.name}</span> },
    { key: 't', head: 'Trades', width: 200, cell: (v) => (profileOf.get(v.id)?.trades ?? []).join(', ') || '—' },
    { key: 'd', head: 'CSI divisions', width: 240, cell: (v) => (profileOf.get(v.id)?.csi_divisions ?? []).map((d) => `${d} ${divisionName(d)}`).join('; ') || '—' },
    { key: 'c', head: 'Certifications', width: 170, cell: (v) => { const p = profileOf.get(v.id); return p ? [p.dbe && 'DBE', p.mbe && 'MBE', p.wbe && 'WBE', p.sdvob && 'SDVOB'].filter(Boolean).join(' · ') || '—' : <span className="t-cap">No trade data</span>; } },
    { key: 'e', head: 'EMR', n: true, width: 70, cell: (v) => { const e = profileOf.get(v.id)?.emr; return e == null ? '—' : Number(e).toFixed(2); } },
    { key: 'l', head: 'Licenses', width: 160, cell: (v) => { const l = profileOf.get(v.id)?.licenses ?? []; return l.length ? l.map((x) => [x.state, x.number].filter(Boolean).join(' ')).join(', ') : '—'; } },
  ];

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Tabs aria-label="Directory views" value={tab} onChange={setTab} items={[{ value: 'directory', label: 'Project directory', count: inJob.length }, { value: 'trades', label: 'Trade data', count: profiles.length }]} />
      <div className="ops-toolbar">
        {tab === 'directory' && <Field label="Job"><JobSelect jobs={jobs} value={jobId} onChange={setJobId} placeholder="Every job" /></Field>}
        {tab === 'directory' && <Field label="Role"><Select value={role} onChange={(e) => setRole(e.target.value)}><option value="">Every role</option>{PARTY_ROLES.map((r) => <option key={r} value={r}>{words(r)}</option>)}</Select></Field>}
        {tab === 'directory' && groups.length > 0 && <Field label="Distribution group"><Select value={group} onChange={(e) => setGroup(e.target.value)}><option value="">Everyone</option>{groups.map((g) => <option key={g} value={g}>{g}</option>)}</Select></Field>}
        <div style={{ width: 280 }}><Search aria-label="Find in the directory" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Company, contact, trade, division" slashToFocus /></div>
        <span className="sp" />
        {tab === 'directory' && emails.length > 0 && <a className="btn" href={`mailto:?bcc=${encodeURIComponent(emails.join(','))}`}>Email {emails.length}</a>}
        {tab === 'directory' && edit && jobId && <Button disabled={busy !== null} onClick={() => void act<{ added: number }>('seed', 'post', '/api/commercial/directory', { jobId }, (d) => `Added ${d.added} from the job’s customer and subcontracts`)}>{busy === 'seed' ? 'Filling…' : 'Fill from the job'}</Button>}
        {tab === 'directory' && edit && <Button variant="primary" icon="plus" chord="n" bindChord onClick={() => setAdding((v) => !v)}>Add to directory</Button>}
      </div>
      <Failure text={error} />
      {tab === 'directory' && adding && edit && <NewEntry jobs={jobs.filter((j) => j.open)} defaultJobId={jobId} vendors={vendors} busy={busy} act={act} onDone={() => setAdding(false)} />}
      {tab === 'directory' && <CmTable label="Project directory" keys rows={shown} cols={cols} rowKey={(e) => e.directory_id} onOpen={(e) => setOpenId(e.directory_id)} activeId={openId}
        rowTone={(e) => (e.prequal_status === 'EXPIRED' || e.prequal_status === 'DISQUALIFIED' ? 'neg' : null)}
        empty={{ title: needle || role || group ? 'Nobody matches' : 'The directory is empty', body: 'Fill it from the job — the owner or GC and every company on a subcontract or PO — then add the architect, engineers and inspectors.' }} />}
      {tab === 'trades' && <CmTable label="Trade data" keys rows={tradeRows} cols={tcols} rowKey={(v) => v.id} onOpen={(v) => setProfileFor(v.id)} activeId={profileFor}
        empty={{ title: 'No trade data yet', body: 'Open a subcontractor to record its trades, CSI divisions, licenses, union local, DBE / MBE / WBE status and EMR. It lives on the shared vendor record, so every job sees it.' }} />}
      <TableKeys extra={tab === 'directory' && edit ? [{ chord: 'n', label: 'Add' }] : []} />

      <Drawer open={!!open} onClose={() => setOpenId(null)} width={500} title={open?.company_name ?? open?.contact_name ?? ''} eyebrow={open ? [words(open.party_role), byJob.get(open.job_id)?.label].filter(Boolean).join(' // ') : undefined}>
        {open && <EntryDetail key={open.directory_id} e={open} edit={edit} busy={busy} act={act} onRemoved={() => setOpenId(null)} onProfile={open.vendor_id ? () => { setProfileFor(open.vendor_id); setOpenId(null); } : undefined} />}
      </Drawer>
      <Drawer open={!!profileFor} onClose={() => setProfileFor(null)} width={520} title={profileFor ? vendorName.get(profileFor) ?? 'Company' : ''} eyebrow="Trade data // shared vendor record">
        {profileFor && <ProfileForm key={profileFor} vendorId={profileFor} companyId={jobs[0]?.companyId ?? null} p={profileOf.get(profileFor) ?? null} edit={!readOnly && canEditProfiles} busy={busy} act={act} />}
      </Drawer>
    </div>
  );
}

function NewEntry({ jobs, defaultJobId, vendors, busy, act, onDone }: { jobs: JobOption[]; defaultJobId: string; vendors: Array<{ id: string; name: string }>; busy: string | null; act: Act; onDone: () => void }) {
  const [jobId, setJobId] = useState(defaultJobId);
  const [role, setRole] = useState<string>('ARCHITECT');
  const [vendorId, setVendorId] = useState('');
  const [company, setCompany] = useState('');
  const [contact, setContact] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [groupsText, setGroupsText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="mp-table mp-add" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }} onSubmit={async (e) => {
      e.preventDefault();
      if (!jobId) return setErr('Pick the job.');
      if (!vendorId && !company.trim() && !contact.trim()) return setErr('Name the company or the contact.');
      if (email.trim() && !/^\S+@\S+\.\S+$/.test(email.trim())) return setErr('Use an email address.');
      setErr(null);
      const r = await act('add', 'post', '/api/commercial/directory/entries', {
        jobId, partyRole: role, vendorId: vendorId || null, companyName: vendorId ? null : company.trim() || null, contactName: contact.trim() || null,
        email: email.trim() || null, phone: phone.trim() || null, distributionGroups: csv(groupsText),
      }, 'Added to the directory');
      if (r) onDone();
    }}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Job" error={err ?? undefined}><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>
        <Field label="Role"><Select value={role} onChange={(e) => setRole(e.target.value)}>{PARTY_ROLES.map((r) => <option key={r} value={r}>{words(r)}</option>)}</Select></Field>
        <Field label="From the vendor list"><Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}><option value="">Not a vendor</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></Field>
        {!vendorId && <Field label="Company"><Input value={company} onChange={(e) => setCompany(e.target.value)} maxLength={200} style={{ width: 220 }} /></Field>}
      </div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Contact"><Input value={contact} onChange={(e) => setContact(e.target.value)} maxLength={200} /></Field>
        <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} /></Field>
        <Field label="Phone"><Input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} /></Field>
        <Field label="Distribution groups" help="Comma separated: oac, rfis, subs"><Input value={groupsText} onChange={(e) => setGroupsText(e.target.value)} maxLength={200} /></Field>
      </div>
      <div><Button type="submit" variant="primary" disabled={busy !== null}>{busy === 'add' ? 'Adding…' : 'Add'}</Button></div>
    </form>
  );
}

function EntryDetail({ e, edit, busy, act, onRemoved, onProfile }: { e: DirectoryEntry; edit: boolean; busy: string | null; act: Act; onRemoved: () => void; onProfile?: () => void }) {
  const [contact, setContact] = useState(e.contact_name ?? '');
  const [email, setEmail] = useState(e.email ?? '');
  const [phone, setPhone] = useState(e.phone ?? '');
  const [trade, setTrade] = useState(e.trade ?? '');
  const [divs, setDivs] = useState((e.csi_divisions ?? []).join(', '));
  const [groups, setGroups] = useState((e.distribution_groups ?? []).join(', '));
  const [primary, setPrimary] = useState(e.is_primary);
  const [confirm, setConfirm] = useState(false);
  const url = `/api/commercial/directory/entries/${e.directory_id}`;
  return (
    <div className="stack" style={{ gap: 20 }}>
      <KV items={[
        { term: 'Licenses', value: (e.licenses ?? []).map((l) => [l.state, l.number, l.class].filter(Boolean).join(' ')).join('; ') || '—' },
        { term: 'Union local', value: e.union_local ?? '—' },
        { term: 'DBE / MBE / WBE', value: [e.dbe && 'DBE', e.mbe && 'MBE', e.wbe && 'WBE'].filter(Boolean).join(' · ') || 'None recorded' },
        { term: 'EMR', value: e.emr == null ? '—' : Number(e.emr).toFixed(2) },
        { term: 'Prequalification', value: e.prequal_status ? words(e.prequal_status) : '—' },
      ]} />
      {onProfile && <Button variant="quiet" onClick={onProfile}>Open the company’s trade data</Button>}
      {edit && (
        <DSection title="On this job">
          <form className="stack" style={{ gap: 8 }} onSubmit={(ev) => {
            ev.preventDefault();
            void act('save', 'patch', url, { contactName: contact.trim() || null, email: email.trim() || null, phone: phone.trim() || null, trade: trade.trim() || null,
              csiDivisions: csv(divs).map((d) => d.slice(0, 4)), distributionGroups: csv(groups), isPrimary: primary }, 'Saved the directory entry');
          }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Field label="Contact"><Input value={contact} onChange={(x) => setContact(x.target.value)} maxLength={200} /></Field>
              <Field label="Email"><Input type="email" value={email} onChange={(x) => setEmail(x.target.value)} maxLength={200} /></Field>
              <Field label="Phone"><Input value={phone} onChange={(x) => setPhone(x.target.value)} maxLength={40} /></Field>
            </div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Field label="Trade"><Input value={trade} onChange={(x) => setTrade(x.target.value)} maxLength={80} /></Field>
              <Field label="CSI divisions" help="Comma separated: 26, 27"><Input value={divs} onChange={(x) => setDivs(x.target.value)} maxLength={120} /></Field>
            </div>
            <Field label="Distribution groups"><Input value={groups} onChange={(x) => setGroups(x.target.value)} maxLength={200} /></Field>
            <Check label="Primary contact for this role" checked={primary} onChange={(x) => setPrimary(x.target.checked)} />
            <div className="row" style={{ gap: 8 }}>
              <Button type="submit" variant="primary" disabled={busy !== null}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
              <Button variant="danger" disabled={busy !== null} onClick={() => setConfirm(true)}>Remove from this job</Button>
            </div>
          </form>
        </DSection>
      )}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title="Remove from this job's directory?" confirmLabel="Remove"
        onConfirm={async () => { const r = await act('remove', 'delete', url, undefined, 'Removed from the directory'); setConfirm(false); if (r) onRemoved(); }}>
        The company stays on the shared vendor and customer list; only this job’s entry goes.
      </ConfirmDialog>
    </div>
  );
}

function ProfileForm({ vendorId, companyId, p, edit, busy, act }: { vendorId: string; companyId: string | null; p: CompanyProfile | null; edit: boolean; busy: string | null; act: Act }) {
  const mv = useMoneyVis();
  const [trades, setTrades] = useState((p?.trades ?? []).join(', '));
  const [divs, setDivs] = useState((p?.csi_divisions ?? []).join(', '));
  const [lic, setLic] = useState((p?.licenses ?? []).map((l) => [l.state, l.number].filter(Boolean).join(' ')).join(', '));
  const [union, setUnion] = useState(p?.union_local ?? '');
  const [flags, setFlags] = useState({ dbe: p?.dbe ?? false, mbe: p?.mbe ?? false, wbe: p?.wbe ?? false, sdvob: p?.sdvob ?? false });
  const [emr, setEmr] = useState(p?.emr == null ? '' : String(p.emr));
  const [emrYear, setEmrYear] = useState(p?.emr_year == null ? '' : String(p.emr_year));
  const [single, setSingle] = useState<number | null>(p?.bonding_single_cents ?? null);
  const [agg, setAgg] = useState<number | null>(p?.bonding_aggregate_cents ?? null);
  const [pq, setPq] = useState(p?.prequal_status ?? 'NONE');
  const [pqExp, setPqExp] = useState(p?.prequal_expires ?? '');
  const [notes, setNotes] = useState(p?.notes ?? '');
  const [err, setErr] = useState<string | null>(null);
  if (!edit) {
    return <KV items={[
      { term: 'Trades', value: (p?.trades ?? []).join(', ') || '—' }, { term: 'CSI divisions', value: (p?.csi_divisions ?? []).join(', ') || '—' },
      { term: 'EMR', value: p?.emr == null ? '—' : Number(p.emr).toFixed(2) }, { term: 'Union local', value: p?.union_local ?? '—' },
      ...(mv.cost ? [{ term: 'Bonding (single / aggregate)', value: `${cm(p?.bonding_single_cents ?? null, 0)} / ${cm(p?.bonding_aggregate_cents ?? null, 0)}` }] : []),
    ]} />;
  }
  return (
    <form className="stack" style={{ gap: 10 }} onSubmit={(e) => {
      e.preventDefault();
      const emrN = emr.trim() ? Number(emr) : null;
      if (emrN !== null && (!Number.isFinite(emrN) || emrN < 0 || emrN > 5)) return setErr('EMR is a number like 0.85.');
      setErr(null);
      void act('profile', 'post', '/api/commercial/profiles', {
        vendorId, customerId: null, companyId, trades: csv(trades), csiDivisions: csv(divs).map((d) => d.slice(0, 4)),
        licenses: csv(lic).map((l) => { const [state, ...rest] = l.split(/\s+/); return /^[A-Za-z]{2}$/.test(state ?? '') && rest.length ? { state: state!.toUpperCase(), number: rest.join(' ') } : { number: l }; }),
        unionLocal: union.trim() || null, ...flags, emr: emrN, emrYear: emrYear.trim() ? Number(emrYear) : null,
        ...(mv.cost ? { bondingSingleCents: single, bondingAggregateCents: agg } : {}), prequalStatus: pq, prequalExpires: pqExp || null, notes: notes.trim() || null,
      }, 'Saved the trade data');
    }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Field label="Trades"><Input value={trades} onChange={(e) => setTrades(e.target.value)} placeholder="Electrical, low voltage" /></Field>
        <Field label="CSI divisions"><Input value={divs} onChange={(e) => setDivs(e.target.value)} placeholder="26, 27, 28" /></Field>
      </div>
      <Field label="Licenses" help="State and number, comma separated: IA 12345, NE E-778"><Input value={lic} onChange={(e) => setLic(e.target.value)} /></Field>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        {(['dbe', 'mbe', 'wbe', 'sdvob'] as const).map((k) => <Check key={k} label={k.toUpperCase()} checked={flags[k]} onChange={(e) => setFlags((f) => ({ ...f, [k]: e.target.checked }))} />)}
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Field label="Union local"><Input value={union} onChange={(e) => setUnion(e.target.value)} maxLength={80} placeholder="IBEW 347" /></Field>
        <Field label="EMR" error={err ?? undefined}><Input inputMode="decimal" value={emr} onChange={(e) => setEmr(e.target.value)} style={{ width: 80 }} /></Field>
        <Field label="EMR year"><Input inputMode="numeric" value={emrYear} onChange={(e) => setEmrYear(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))} style={{ width: 80 }} /></Field>
      </div>
      {mv.cost && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Field label="Bonding, single job"><MoneyInput valueCents={single} onChangeCents={setSingle} /></Field>
          <Field label="Bonding, aggregate"><MoneyInput valueCents={agg} onChangeCents={setAgg} /></Field>
        </div>
      )}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Field label="Prequalification"><Select value={pq} onChange={(e) => setPq(e.target.value)}>{['NONE', 'PENDING', 'QUALIFIED', 'EXPIRED', 'DISQUALIFIED'].map((s) => <option key={s} value={s}>{words(s)}</option>)}</Select></Field>
        <Field label="Expires"><Input type="date" value={pqExp} onChange={(e) => setPqExp(e.target.value)} /></Field>
      </div>
      <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></Field>
      <div><Button type="submit" variant="primary" disabled={busy !== null}>{busy === 'profile' ? 'Saving…' : 'Save trade data'}</Button></div>
    </form>
  );
}
