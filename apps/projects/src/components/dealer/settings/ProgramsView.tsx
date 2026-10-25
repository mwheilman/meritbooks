'use client';

import { useState } from 'react';
import { Button, Field, Input, QueueTable, Select, Status, money, type QueueColumn } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, centsFrom, day, pctText, useBoard, useDo } from '../common/depth';

interface Program { id: string; code: string; name: string; kind: string; brand: string | null; apr: number; term_months: number | null; subvention_pct: number | null; rebate_cents: number; min_amount_cents: number; starts_on: string | null; ends_on: string | null; is_active: boolean }
interface Fee { id: string; code: string; label: string; kind: string; amount_cents: number; cost_cents: number | null; taxable: boolean; auto_apply: boolean; is_active: boolean }
interface IntegrationRow { id: string; provider: string; brand: string; enabled: boolean; status: string; config: Record<string, string> }

/** Finance programs and standard fees the desk offers, and the catalog / OEM interfaces the counter and warranty use. */
export function ProgramsView({ companyId, today }: { companyId: string; today: string }) {
  const { readOnly } = useShell();
  const b = useBoard<{ programs: Program[]; fees: Fee[] }>(`/api/dealer/programs?company=${companyId}`);
  const ints = useBoard<{ integrations: IntegrationRow[] }>(`/api/dealer/integrations?company=${companyId}`);
  const { run, busy, error } = useDo(() => { b.reload(); ints.reload(); });
  const [p, setP] = useState({ code: '', name: '', kind: 'PROMO_RATE', brand: '', apr: '', term: '60', sub: '', rebate: '', ends: '' });
  const [f, setF] = useState({ code: '', label: '', kind: 'DOC', amount: '', cost: '' });
  const [cat, setCat] = useState({ provider: 'PARTSTREAM', url: '', brand: 'KUBOTA', dealer: '' });

  const pcols: QueueColumn<Program>[] = [
    { id: 'n', header: 'Program', cell: (x) => <><span className="l1">{x.name}</span><span className="l2">{x.code}{x.brand ? ` · ${x.brand}` : ''}</span></> },
    { id: 't', header: 'Terms', width: 200, cell: (x) => (x.kind === 'CASH_REBATE' ? `Rebate ${money(x.rebate_cents)}` : `${pctText(x.apr, 2)} · ${x.term_months} months`) },
    { id: 's', header: 'Buy-down', numeric: true, width: 100, cell: (x) => (x.subvention_pct == null ? '—' : pctText(x.subvention_pct, 2)) },
    { id: 'e', header: 'Ends', width: 110, cell: (x) => day(x.ends_on, today) },
    { id: 'a', header: 'Status', width: 140, cell: (x) => (x.is_active ? <Status kind="ready" pip="open">Offered</Status> : <Status kind="blocked" pip="closed">Ended</Status>) },
    ...(readOnly ? [] : [{ id: 'x', header: <span className="sr">End</span>, width: 90, cell: (x: Program) => (x.is_active ? <Button variant="quiet" disabled={busy === x.id} onClick={() => void run(x.id, '/api/dealer/programs', { op: 'end_program', programId: x.id }, 'Ended the program')}>End</Button> : null) } satisfies QueueColumn<Program>]),
  ];

  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <Section title="Finance programs" meta="Promo rates, standard rates and cash rebates">
        <BoardState b={b} what="Programs" />
        {b.data && (b.data.programs.length === 0 ? <Empty title="No programs yet" body="Add the manufacturer’s current promo rates and rebates so the desk can show every payment option side by side." /> : <div className="mp-table"><QueueTable aria-label="Finance programs" columns={pcols} rows={b.data.programs} getRowId={(x) => x.id} rowState={(x) => ({ done: !x.is_active })} /></div>)}
        {!readOnly && (
          <div className="ops-toolbar" style={{ marginTop: 8 }}>
            <Field label="Code"><Input value={p.code} onChange={(e) => setP({ ...p, code: e.target.value })} style={{ width: 100 }} /></Field>
            <Field label="Name"><Input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} style={{ width: 180 }} /></Field>
            <Field label="Kind"><Select value={p.kind} onChange={(e) => setP({ ...p, kind: e.target.value })}><option value="PROMO_RATE">Promo rate</option><option value="STANDARD_RATE">Standard rate</option><option value="CASH_REBATE">Cash rebate</option></Select></Field>
            <Field label="Brand"><Input value={p.brand} onChange={(e) => setP({ ...p, brand: e.target.value.toUpperCase() })} style={{ width: 100 }} /></Field>
            {p.kind !== 'CASH_REBATE' ? <>
              <Field label="APR %"><Input inputMode="decimal" value={p.apr} onChange={(e) => setP({ ...p, apr: e.target.value })} style={{ width: 70 }} /></Field>
              <Field label="Months"><Input inputMode="numeric" value={p.term} onChange={(e) => setP({ ...p, term: e.target.value })} style={{ width: 70 }} /></Field>
              <Field label="Buy-down %"><Input inputMode="decimal" value={p.sub} onChange={(e) => setP({ ...p, sub: e.target.value })} style={{ width: 80 }} /></Field>
            </> : <Field label="Rebate"><Input inputMode="decimal" value={p.rebate} onChange={(e) => setP({ ...p, rebate: e.target.value })} style={{ width: 100 }} /></Field>}
            <Field label="Ends"><Input type="date" value={p.ends} onChange={(e) => setP({ ...p, ends: e.target.value })} /></Field>
            <Button variant="primary" disabled={!p.code.trim() || !p.name.trim() || busy === 'addp'} onClick={async () => {
              const program = { code: p.code.trim(), name: p.name.trim(), kind: p.kind, brand: p.brand || null, apr: p.kind === 'CASH_REBATE' ? 0 : Number(p.apr || 0) / 100, termMonths: p.kind === 'CASH_REBATE' ? null : Number(p.term), subventionPct: Number(p.sub || 0) / 100, rebateCents: centsFrom(p.rebate) ?? 0, endsOn: p.ends || null };
              if (await run('addp', '/api/dealer/programs', { op: 'add_program', companyId, program }, 'Added the program')) setP({ ...p, code: '', name: '' });
            }}>Add program</Button>
          </div>
        )}
      </Section>
      <Section title="Standard fees" meta="Added to every deal with one click on the desk">
        {b.data && (b.data.fees.length === 0 ? <p className="t-cap">No standard fees.</p> : (
          <table className="ops-mini" aria-label="Fees"><thead><tr><th>Code</th><th>Fee</th><th className="n">Amount</th><th className="n">Cost</th><th /></tr></thead>
            <tbody>{b.data.fees.map((x) => <tr key={x.id} className={x.is_active ? undefined : 'void'}><td className="code">{x.code}</td><td>{x.label}</td><td className="n">{money(x.amount_cents)}</td><td className="n">{x.cost_cents == null ? '—' : money(x.cost_cents)}</td>
              <td>{!readOnly && x.is_active && <Button variant="quiet" disabled={busy === x.id} onClick={() => void run(x.id, '/api/dealer/programs', { op: 'end_fee', feeId: x.id }, 'Retired the fee')}>Retire</Button>}</td></tr>)}</tbody></table>
        ))}
        {!readOnly && (
          <div className="ops-toolbar" style={{ marginTop: 8 }}>
            <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} style={{ width: 110 }} /></Field>
            <Field label="Label"><Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} style={{ width: 180 }} /></Field>
            <Field label="Kind"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{['DOC', 'SETUP', 'FREIGHT', 'PDI', 'ENVIRONMENTAL', 'OTHER'].map((k) => <option key={k} value={k}>{k.toLowerCase()}</option>)}</Select></Field>
            <Field label="Amount"><Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} style={{ width: 100 }} /></Field>
            <Field label="Cost"><Input inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} style={{ width: 100 }} /></Field>
            <Button disabled={f.code.length < 2 || !f.label.trim() || centsFrom(f.amount) == null || busy === 'addf'} onClick={async () => {
              if (await run('addf', '/api/dealer/programs', { op: 'add_fee', companyId, fee: { code: f.code, label: f.label.trim(), kind: f.kind, amountCents: centsFrom(f.amount), costCents: centsFrom(f.cost) ?? 0 } }, 'Added the fee')) setF({ code: '', label: '', kind: 'DOC', amount: '', cost: '' });
            }}>Add fee</Button>
          </div>
        )}
      </Section>
      <Section title="Catalogs and manufacturer interfaces" meta="Addresses and dealer numbers only; no passwords are stored">
        <BoardState b={ints} what="Interfaces" />
        {ints.data && (ints.data.integrations.length === 0 ? <p className="t-cap">Nothing set up. Add the parts catalog’s lookup address so the counter can open it for a model or serial.</p> : (
          <table className="ops-mini" aria-label="Interfaces"><thead><tr><th>Interface</th><th>Brand</th><th>Status</th><th>Address</th></tr></thead>
            <tbody>{ints.data.integrations.map((x) => <tr key={x.id}><td>{x.provider.replace(/_/g, ' ').toLowerCase()}</td><td>{x.brand || '—'}</td><td>{x.status === 'CONNECTED' ? 'Direct' : x.status === 'PORTAL_ASSIST' ? 'Portal assist' : 'Off'}</td><td className="l2">{x.config.url_template ?? x.config.portal_url ?? '—'}</td></tr>)}</tbody></table>
        ))}
        {!readOnly && (
          <div className="ops-toolbar" style={{ marginTop: 8 }}>
            <Field label="Interface"><Select value={cat.provider} onChange={(e) => setCat({ ...cat, provider: e.target.value })}><option value="PARTSTREAM">PartStream</option><option value="PARTSMART">PartSmart</option><option value="OEM_WARRANTY">OEM warranty portal</option></Select></Field>
            {cat.provider === 'OEM_WARRANTY' && <Field label="Brand"><Input value={cat.brand} onChange={(e) => setCat({ ...cat, brand: e.target.value.toUpperCase() })} style={{ width: 110 }} /></Field>}
            <Field label={cat.provider === 'OEM_WARRANTY' ? 'Portal address' : 'Lookup address with {part} or {model}'} help={cat.provider === 'OEM_WARRANTY' ? undefined : 'Copy it from your catalog account; {brand} {model} {serial} {part} are filled in.'}>
              <Input value={cat.url} onChange={(e) => setCat({ ...cat, url: e.target.value })} style={{ width: 360 }} placeholder="https://" />
            </Field>
            <Field label="Dealer number"><Input value={cat.dealer} onChange={(e) => setCat({ ...cat, dealer: e.target.value })} style={{ width: 120 }} /></Field>
            <Button disabled={!cat.url.trim() || busy === 'int'} onClick={() => void run('int', '/api/dealer/integrations', { companyId, provider: cat.provider, brand: cat.provider === 'OEM_WARRANTY' ? cat.brand : '', enabled: true, status: 'PORTAL_ASSIST', urlTemplate: cat.provider === 'OEM_WARRANTY' ? null : cat.url.trim(), portalUrl: cat.provider === 'OEM_WARRANTY' ? cat.url.trim() : null, dealerNumber: cat.dealer || null }, 'Saved the interface')}>Save</Button>
          </div>
        )}
      </Section>
    </div>
  );
}
