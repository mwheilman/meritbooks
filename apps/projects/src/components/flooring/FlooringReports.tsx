'use client';

import { useState } from 'react';
import { AppLink, Button, Check, Field, Figure, Input, money } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, FilePick, day, pctText, qty, useBoard, useDo } from '@/components/dealer/common/depth';

interface Reports {
  from: string; to: string;
  sales_by_salesperson: Array<{ salesperson: string | null; quotes: number; sold: number; sold_cents: number | null }>;
  material_vs_labor: Record<string, { sell_cents: number | null; cost_cents: number | null; margin_pct: number | null }>;
  close_rate: { won?: number; lost?: number; close_rate?: number | null; by_source?: Record<string, number> };
  deposit_aging: { under_30_cents: number | null; '30_60_cents': number | null; over_60_cents: number | null; requests: number } | null;
  completed_unbilled: Array<{ job_id: string; job_number: string; name: string; installed_on: string }>;
  installer_productivity: Array<{ crew_id: string | null; crew: string | null; sf: number; crew_days: number; sf_per_crew_day: number | null }>;
  waste: { planned_in: number | null; actual_in: number | null; over_pct: number | null } | null;
  callbacks: { by_installer: Array<{ installer: string | null; callbacks: number }>; by_mill: Array<{ mill: string | null; callbacks: number }>; jobs_installed: number; callbacks: number };
}
interface PriceImport { id: string; source: string; file_name: string | null; effective_on: string | null; status: string; summary: Record<string, number> | null; created_at: string }
interface Member { membershipId: string; name: string }

const firstOfMonth = (iso: string) => `${iso.slice(0, 7)}-01`;

/** Store reports (FLR-44), the salesperson rotation (FLR-03) and vendor price files — 832 EDI or a mill sheet (FLR-14). */
export function FlooringReports({ companyId, today, members }: { companyId: string; today: string; members: Member[] }) {
  const { readOnly } = useShell();
  const url = '/api/flooring/ops';
  const [from, setFrom] = useState(firstOfMonth(today));
  const [to, setTo] = useState(today);
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const r = useBoard<Reports>(ok ? `${url}?company=${companyId}&view=reports&from=${from}&to=${to}` : null);
  const rot = useBoard<{ rotation: { members: string[]; next_index: number; followup_hours: number } | null }>(`${url}?company=${companyId}&view=rotation`);
  const pf = useBoard<{ imports: PriceImport[] }>(`${url}?company=${companyId}&view=price_imports`);
  const { run, busy, error } = useDo(() => { rot.reload(); pf.reload(); });
  const [picked, setPicked] = useState<string[] | null>(null);
  const [hours, setHours] = useState<string | null>(null);
  const current = picked ?? rot.data?.rotation?.members ?? [];
  const hrs = hours ?? String(rot.data?.rotation?.followup_hours ?? 2);
  const d = r.data;
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <div className="ops-toolbar">
        <Field label="From" error={ok ? undefined : 'From must be on or before To'}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <BoardState b={r} what="Reports" />
      {d && <>
        <div className="dl-strip">
          <Figure dense label="Close rate" value={pctText(d.close_rate.close_rate ?? null, 0)} vs={[`${d.close_rate.won ?? 0} won`, `${d.close_rate.lost ?? 0} lost`]} href="/leads" linkLabel="Leads" />
          <Figure dense label="Deposits waiting" value={d.deposit_aging ? money((d.deposit_aging.under_30_cents ?? 0) + (d.deposit_aging['30_60_cents'] ?? 0) + (d.deposit_aging.over_60_cents ?? 0), { decimals: 0 }) : '—'}
            vs={[d.deposit_aging ? `${money(d.deposit_aging.over_60_cents ?? 0, { decimals: 0 })} over 60 days` : 'hidden', `${d.deposit_aging?.requests ?? 0} requests`]} href="/billing" linkLabel="Billing" />
          <Figure dense label="Callbacks" value={qty(d.callbacks.callbacks)} vs={[`${d.callbacks.jobs_installed} jobs installed`, d.callbacks.jobs_installed ? pctText(d.callbacks.callbacks / d.callbacks.jobs_installed, 1) : '—']} href="/flooring" linkLabel="Jobs" />
          <Figure dense label="Roll waste" value={pctText(d.waste?.over_pct ?? null, 1)} vs={['cut over plan', d.waste?.planned_in ? `${qty(Math.round((d.waste.planned_in ?? 0) / 12))} ft planned` : 'no cuts']} href="/flooring/rolls" linkLabel="Rolls" />
        </div>
        <div className="ops-split">
          <Section title="Sales by salesperson">
            {d.sales_by_salesperson.length === 0 ? <p className="l2">No quotes in this period.</p> :
              <table className="ops-mini" aria-label="Sales by salesperson"><thead><tr><th>Salesperson</th><th className="n">Quotes</th><th className="n">Sold</th><th className="n">Sold $</th></tr></thead>
                <tbody>{d.sales_by_salesperson.map((s, i) => <tr key={i}><td>{s.salesperson ?? 'Unassigned'}</td><td className="n">{s.quotes}</td><td className="n">{s.sold}</td><td className="n">{s.sold_cents == null ? '—' : money(s.sold_cents, { decimals: 0 })}</td></tr>)}</tbody></table>}
          </Section>
          <Section title="Material vs. labor">
            {Object.keys(d.material_vs_labor).length === 0 ? <p className="l2">Nothing sold.</p> :
              <table className="ops-mini" aria-label="Material vs labor"><thead><tr><th /><th className="n">Sell</th><th className="n">Cost</th><th className="n">Margin</th></tr></thead>
                <tbody>{Object.entries(d.material_vs_labor).map(([k, v]) => <tr key={k}><td>{k.toLowerCase()}</td><td className="n">{v.sell_cents == null ? '—' : money(v.sell_cents, { decimals: 0 })}</td><td className="n">{v.cost_cents == null ? '—' : money(v.cost_cents, { decimals: 0 })}</td><td className="n">{pctText(v.margin_pct)}</td></tr>)}</tbody></table>}
          </Section>
        </div>
        <div className="ops-split">
          <Section title="Installer productivity">
            {d.installer_productivity.length === 0 ? <p className="l2">No installs in this period.</p> :
              <table className="ops-mini" aria-label="Installer productivity"><thead><tr><th>Crew</th><th className="n">SF</th><th className="n">Crew-days</th><th className="n">SF / day</th></tr></thead>
                <tbody>{d.installer_productivity.map((c, i) => <tr key={c.crew_id ?? i}><td>{c.crew ?? 'No crew'}</td><td className="n">{qty(c.sf)}</td><td className="n">{qty(c.crew_days)}</td><td className="n">{qty(c.sf_per_crew_day)}</td></tr>)}</tbody></table>}
          </Section>
          <Section title="Callbacks by installer and mill">
            {d.callbacks.by_installer.length + d.callbacks.by_mill.length === 0 ? <p className="l2">No callbacks.</p> : <ul className="l2">
              {d.callbacks.by_installer.map((x, i) => <li key={`i${i}`}>{x.installer ?? 'Unknown installer'}: {x.callbacks}</li>)}
              {d.callbacks.by_mill.map((x, i) => <li key={`m${i}`}>{x.mill ?? 'Unknown mill'}: {x.callbacks}</li>)}</ul>}
          </Section>
        </div>
        <Section title="Installed, not billed" meta={`${d.completed_unbilled.length} job(s)`}>
          {d.completed_unbilled.length === 0 ? <p className="l2">Every installed job has its completion invoice.</p> :
            <ul className="ops-agenda">{d.completed_unbilled.map((j) => <li key={j.job_id}><span className="d">{day(j.installed_on, today)}</span><span><AppLink href={`/flooring/jobs/${j.job_id}`}>{j.job_number}</AppLink> {j.name}</span></li>)}</ul>}
        </Section>
      </>}

      <Section title="Salesperson rotation" meta="Walk-ins and web leads go to the next person in turn, with a follow-up task">
        <BoardState b={rot} what="Rotation" />
        {rot.data && (members.length === 0 ? <p className="l2">No team members at this company.</p> : <div className="stack">
          <span className="btn-row">{members.map((m) => <Check key={m.membershipId} disabled={readOnly} checked={current.includes(m.membershipId)} label={m.name}
            onChange={(e) => setPicked(e.target.checked ? [...current, m.membershipId] : current.filter((x) => x !== m.membershipId))} />)}</span>
          {!readOnly && <div className="ops-toolbar">
            <Field label="Follow up within (hours)" error={/^\d{1,2}$/.test(hrs) && Number(hrs) <= 72 ? undefined : '0 to 72'}><Input value={hrs} style={{ width: 70 }} onChange={(e) => setHours(e.target.value)} /></Field>
            <Button disabled={!/^\d{1,2}$/.test(hrs) || Number(hrs) > 72 || busy === 'rot'} onClick={async () => { const x = await run('rot', url, { op: 'rotation', companyId, members: current, followupHours: Number(hrs) }, 'Rotation saved'); if (x) { setPicked(null); setHours(null); } }}>Save the rotation</Button>
          </div>}
          {rot.data.rotation && rot.data.rotation.members.length > 0 && <p className="l2">Next up: {members.find((m) => m.membershipId === rot.data!.rotation!.members[rot.data!.rotation!.next_index % rot.data!.rotation!.members.length])?.name ?? 'someone no longer on the team'}</p>}
        </div>)}
      </Section>

      <Section title="Vendor price files" meta="832 EDI or a mill price sheet (CSV); new costs apply on the effective date">
        {!readOnly && <FilePick label="Choose a price file" accept=".csv,.txt,.832,.edi,.x12" disabled={busy === 'pfs'} onText={(name, text) => { void run('pfs', url, { op: 'price_stage', companyId, fileName: name, text }, (x: { lines?: number; changed?: number; new?: number }) => `Staged ${x.lines ?? 0} prices: ${x.changed ?? 0} changed, ${x.new ?? 0} new`); }} />}
        <BoardState b={pf} what="Price files" />
        {pf.data && (pf.data.imports.length === 0 ? <Empty title="No price files yet" body="Drop the mill's 832 or price sheet; matched SKUs update cost (and price, where the rule says) and new styles are listed to add." /> :
          <table className="ops-mini" aria-label="Price files"><thead><tr><th>File</th><th>Source</th><th>Effective</th><th>Status</th><th /></tr></thead>
            <tbody>{pf.data.imports.map((i) => <tr key={i.id}><td>{i.file_name ?? '—'}{i.summary && i.summary.lines != null && <span className="l2"> · {i.summary.lines} prices, {i.summary.new ?? 0} new, {i.summary.changed ?? 0} changed{i.summary.open_quote_margin_impact_cents ? ` · open quotes ${money(i.summary.open_quote_margin_impact_cents, { decimals: 0 })} margin` : ''}</span>}</td><td>{i.source}</td><td>{day(i.effective_on, today)}</td><td>{i.status.toLowerCase()}</td>
              <td>{!readOnly && i.status === 'STAGED' && <Button variant="primary" disabled={busy === `pa${i.id}`} onClick={() => run(`pa${i.id}`, url, { op: 'price_apply', companyId, importId: i.id }, 'Prices updated')}>Apply</Button>}</td></tr>)}</tbody></table>)}
      </Section>
    </div>
  );
}
