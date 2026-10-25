'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, ButtonRow, Check, Field, Figure, InlineNotice, Input, KV, QueueTable, Select, Status, Tabs, Textarea, count, money, type QueueColumn } from '@meritbooks/merit-ui';
import { computeProForma } from '@/lib/development/returns';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, centsFrom, day, pctText, qty, useBoard, useDo } from '@/components/dealer/common/depth';

interface GridRow { cost_code_id: string; code: string; name: string; category: string | null; contingency_pool: string | null; lender_line_id: string | null; lender_line_no: number | null; lender_line: string | null; cip_account_ref: string | null; original_cents: number; revised_cents: number; committed_cents: number; pending_co_cents: number; ecac_cents: number; paid_cents: number; drawn_cents: number; remaining_to_fund_cents: number; variance_cents: number }
interface Balance { has_sources: boolean; in_balance: boolean; gap_cents: number; cost_to_complete_cents: number; remaining_sources_cents: number; total_uses_cents: number; total_sources_cents: number; interest_reserve_months: number | null; sources: Array<{ source_id: string; kind: string; name: string; rank: number; commitment_cents: number; funded_cents: number; remaining_cents: number; over_commitment: boolean }> }
interface Pool { pool: string; original_cents: number; current_cents: number; used_cents: number; burn_pct: number | null; pct_complete: number | null; projected_remaining_cents: number | null; at_risk: boolean }
interface Realloc { reallocation_id: string; from: string; to: string; cents: number; reason: string; status: string; budget_status: string | null; lender_consent_required: boolean; lender_consent_ref: string | null; created_at: string }
interface Data {
  project: { spe_name: string | null; spe_location_id: string | null; product_type: string; stage: string; address: string | null; contract_type: string | null; block_out_of_balance: boolean; spe_request_status: string | null } | null;
  spe: { id: string; status: string; payload: Record<string, unknown>; books_note: string | null; created_at: string } | null;
  proFormas: Array<{ id: string; label: string; kind: string; status: string; inputs: Record<string, unknown>; results: Record<string, number | null> | null; locked_at: string | null; created_at: string }>;
  sources: Array<{ id: string; kind: string; name: string; commitment_cents: number; funded_cents: number; funded_as_of: string | null; rank: number; funding_rule: string }>;
  keyDates: Array<{ id: string; kind: string; label: string | null; due_on: string; status: string }>;
  grid: { rows: GridRow[]; totals: Record<string, number>; unmapped_lines: number } | null;
  balance: Balance | null;
  contingency: { pools: Pool[]; log: Realloc[] } | null;
  investors: { available: boolean; reason?: string; source?: string; holders?: Array<{ name: string; equity_class: string | null; ownership_pct: number | null; capital_contributed_cents: number | null; is_preferred: boolean | null }>; contributed_cents?: number | null; distributions?: { available: boolean; reason?: string } } | null;
  schedules: Array<{ id: string; lender_name: string; loan_number: string | null; loan_commitment_cents: number | null; status: string }>;
  draws: Array<{ id: string; draw_number: number; status: string; period_end: string | null; requested_cents: number | null; approved_cents: number | null }>;
  lenderLines: Array<{ id: string; draw_schedule_id: string; line_no: number; description: string }>;
}
type Tab = 'project' | 'proforma' | 'budget' | 'sources' | 'contingency' | 'draws' | 'investors';
const CATS = ['LAND', 'HARD', 'SOFT', 'FINANCING', 'INTEREST_RESERVE', 'CONTINGENCY', 'DEVELOPER_FEE', 'OTHER'] as const;
const STAGES = ['PURSUIT', 'UNDER_CONTRACT', 'PRE_DEVELOPMENT', 'SPE_FORMED', 'CAPITALIZED', 'CONSTRUCTION', 'SUBSTANTIAL_COMPLETION', 'LEASE_UP', 'STABILIZED', 'REFI_DISPOSITION', 'WIND_DOWN', 'DEAD'] as const;
const KEY_DATES = ['DD_EXPIRY', 'EARNEST_HARD_DATE', 'PSA_CLOSING', 'LOAN_CLOSING', 'RATE_LOCK', 'COMPLETION_GUARANTY', 'OUTSIDE_COMPLETION', 'LOAN_MATURITY', 'EXTENSION_OPTION', 'RATE_CAP_EXPIRY', 'LENDER_REPORT', 'INVESTOR_REPORT', 'OTHER'] as const;
const words = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/_/g, ' ');

/** One development project (one SPE): pro forma, the lender-mapped budget, sources and the in-balance test, contingency, draws, investors. */
export function DevProject({ jobId, today }: { jobId: string; today: string }) {
  const { readOnly } = useShell();
  const url = `/api/development/jobs/${jobId}`;
  const b = useBoard<Data>(url);
  const { run, busy, error } = useDo(b.reload);
  const [tab, setTab] = useState<Tab>('project');
  const [spe, setSpe] = useState({ name: '', state: 'IA' });
  const [pf, setPf] = useState({ label: 'Current', kind: 'CURRENT', cost: '', loan: '', rate: '7', noi: '', flows: '' });
  const [map, setMap] = useState<Record<string, { cat: string; pool: string; line: string; cip: string }>>({});
  const [src, setSrc] = useState({ kind: 'SENIOR_LOAN', name: '', commit: '', funded: '', rank: '2', rule: 'SEQUENCED' });
  const [re, setRe] = useState({ from: '', to: '', amount: '', reason: '', consent: true });
  const [consent, setConsent] = useState<Record<string, string>>({});
  const [kd, setKd] = useState({ kind: 'RATE_LOCK', label: '', due: today });
  const [plan, setPlan] = useState({ start: `${today.slice(0, 7)}-01`, months: '18' });

  const state = <BoardState b={b} what="The project" />;
  if (!b.data) return state;
  const d = b.data;
  const flows = pf.flows.split(/[\s,]+/).filter(Boolean).map((x) => centsFrom(x)).filter((x): x is number => x != null);
  const live = centsFrom(pf.cost) && flows.length >= 2 ? computeProForma({ totalCostCents: centsFrom(pf.cost)!, loanCents: centsFrom(pf.loan) ?? 0, interestRate: Number(pf.rate) / 100, noiAnnualCents: centsFrom(pf.noi) ?? 0, equityCashFlowsCents: flows }) : null;
  const gridCols: QueueColumn<GridRow>[] = [
    { id: 'c', header: 'Cost code', cell: (r) => <><span className="l1">{r.code} · {r.name}</span><span className="l2">{words(r.category) || 'not mapped'}{r.contingency_pool ? ` · ${words(r.contingency_pool)} pool` : ''}{r.lender_line_no != null ? ` · lender line ${r.lender_line_no}` : ''}{r.cip_account_ref ? ` · ${r.cip_account_ref}` : ''}</span></> },
    { id: 'o', header: 'Original', numeric: true, width: 110, cell: (r) => money(r.original_cents, { decimals: 0 }) },
    { id: 'r', header: 'Revised', numeric: true, width: 110, cell: (r) => money(r.revised_cents, { decimals: 0 }) },
    { id: 'm', header: 'Committed', numeric: true, width: 110, cell: (r) => money(r.committed_cents, { decimals: 0 }) },
    { id: 'p', header: 'Pending CO', numeric: true, width: 110, cell: (r) => money(r.pending_co_cents, { decimals: 0 }) },
    { id: 'e', header: 'At completion', numeric: true, width: 120, cell: (r) => <b>{money(r.ecac_cents, { decimals: 0 })}</b> },
    { id: 'pd', header: 'Paid', numeric: true, width: 110, cell: (r) => money(r.paid_cents, { decimals: 0 }) },
    { id: 'dr', header: 'Drawn', numeric: true, width: 110, cell: (r) => money(r.drawn_cents, { decimals: 0 }) },
    { id: 'rf', header: 'To fund', numeric: true, width: 110, cell: (r) => money(r.remaining_to_fund_cents, { decimals: 0 }) },
    { id: 'v', header: 'Variance', numeric: true, width: 110, cell: (r) => <span className={r.variance_cents < 0 ? 'neg b' : undefined}>{money(r.variance_cents, { decimals: 0 })}</span> },
  ];
  const ccName = (id: string) => d.grid?.rows.find((r) => r.cost_code_id === id);

  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {d.balance && d.balance.has_sources && !d.balance.in_balance && <InlineNotice tone="neg" title={`Out of balance by ${money(d.balance.gap_cents)}.`}>Remaining sources do not cover the cost to complete. {d.project?.block_out_of_balance !== false ? 'Draws cannot go to the lender until the gap is funded.' : ''}</InlineNotice>}
      <Tabs<Tab> aria-label="Project" value={tab} onChange={setTab} items={[
        { value: 'project', label: 'Project' }, { value: 'proforma', label: 'Pro forma', count: count(d.proFormas.length) }, { value: 'budget', label: 'Budget' },
        { value: 'sources', label: 'Sources and balance' }, { value: 'contingency', label: 'Contingency' }, { value: 'draws', label: 'Draws', count: count(d.draws.length) }, { value: 'investors', label: 'Investors' },
      ]} />
      {tab === 'project' && (
        <>
          <Section title="Single-purpose entity" meta={d.project?.spe_request_status ? words(d.project.spe_request_status) : 'Not requested'}>
            <KV items={[{ term: 'SPE', value: d.project?.spe_name ?? '—' }, { term: 'Stage', value: words(d.project?.stage) || 'pursuit' }, { term: 'Product', value: words(d.project?.product_type) || '—' }, { term: 'Contract', value: words(d.project?.contract_type) || '—' }]} />
            {d.spe && <p className="t-cap">Requested {day(d.spe.created_at, today)} · {words(d.spe.status)}{d.spe.books_note ? ` · Merit Books: ${d.spe.books_note}` : ''}</p>}
            {!readOnly && !d.spe && (
              <div className="ops-toolbar" style={{ marginTop: 8 }}>
                <Field label="Entity name"><Input value={spe.name} onChange={(e) => setSpe({ ...spe, name: e.target.value })} style={{ width: 240 }} placeholder="Elm Street SPE LLC" /></Field>
                <Field label="State"><Input value={spe.state} maxLength={2} onChange={(e) => setSpe({ ...spe, state: e.target.value.toUpperCase() })} style={{ width: 60 }} /></Field>
                <Button variant="primary" disabled={!spe.name.trim() || spe.state.length !== 2 || busy === 'spe'} onClick={() => void run('spe', url, { op: 'request_spe', entityName: spe.name.trim(), stateOfFormation: spe.state }, 'Asked Merit Books to set up the SPE')}>Ask Merit Books to set up the SPE</Button>
              </div>
            )}
            {!readOnly && (
              <div className="ops-toolbar" style={{ marginTop: 8 }}>
                <Field label="Stage"><Select value={d.project?.stage ?? 'PURSUIT'} onChange={(e) => void run('stage', url, { op: 'set_project', fields: { stage: e.target.value } }, 'Moved the stage')}>{STAGES.map((s) => <option key={s} value={s}>{words(s)}</option>)}</Select></Field>
                <Check label="Block draws while out of balance" checked={d.project?.block_out_of_balance !== false} onChange={(e) => void run('blk', url, { op: 'set_project', fields: { block_out_of_balance: e.target.checked } }, 'Saved')} />
              </div>
            )}
          </Section>
          <Section title="Key dates" meta="Due diligence, closings, rate locks, maturities, reports">
            {d.keyDates.length === 0 ? <p className="t-cap">No dates yet.</p> : (
              <table className="ops-mini" aria-label="Key dates"><thead><tr><th>Due</th><th>Date</th><th>Status</th><th /></tr></thead>
                <tbody>{d.keyDates.map((k) => <tr key={k.id}><td className={k.status === 'OPEN' && k.due_on < today ? 'neg b' : undefined}>{day(k.due_on, today)}</td><td>{k.label ?? words(k.kind)}</td><td>{words(k.status)}</td><td>{!readOnly && k.status === 'OPEN' && <Button variant="quiet" disabled={busy === k.id} onClick={() => void run(k.id, url, { op: 'key_date_done', keyDateId: k.id, status: 'DONE' }, 'Done')}>Done</Button>}</td></tr>)}</tbody></table>
            )}
            {!readOnly && (
              <div className="ops-toolbar" style={{ marginTop: 8 }}>
                <Field label="Kind"><Select value={kd.kind} onChange={(e) => setKd({ ...kd, kind: e.target.value })}>{KEY_DATES.map((k) => <option key={k} value={k}>{words(k)}</option>)}</Select></Field>
                <Field label="Label"><Input value={kd.label} onChange={(e) => setKd({ ...kd, label: e.target.value })} style={{ width: 200 }} /></Field>
                <Field label="Due"><Input type="date" value={kd.due} onChange={(e) => setKd({ ...kd, due: e.target.value })} /></Field>
                <Button disabled={busy === 'kd'} onClick={async () => { if (await run('kd', url, { op: 'add_key_date', kind: kd.kind, label: kd.label || null, dueOn: kd.due }, 'Added the date')) setKd({ ...kd, label: '' }); }}>Add date</Button>
              </div>
            )}
          </Section>
        </>
      )}
      {tab === 'proforma' && (
        <Section title="Pro forma" meta="Deterministic returns; the database recomputes and stores every version">
          {!readOnly && (
            <>
              <div className="ops-toolbar">
                <Field label="Label"><Input value={pf.label} onChange={(e) => setPf({ ...pf, label: e.target.value })} style={{ width: 140 }} /></Field>
                <Field label="Version"><Select value={pf.kind} onChange={(e) => setPf({ ...pf, kind: e.target.value })}><option value="UNDERWRITTEN">Underwritten</option><option value="IC_APPROVED">IC approved</option><option value="CURRENT">Current</option><option value="SCENARIO">Scenario</option></Select></Field>
                <Field label="Total cost"><Input inputMode="decimal" value={pf.cost} onChange={(e) => setPf({ ...pf, cost: e.target.value })} style={{ width: 130 }} /></Field>
                <Field label="Loan"><Input inputMode="decimal" value={pf.loan} onChange={(e) => setPf({ ...pf, loan: e.target.value })} style={{ width: 130 }} /></Field>
                <Field label="Rate %"><Input inputMode="decimal" value={pf.rate} onChange={(e) => setPf({ ...pf, rate: e.target.value })} style={{ width: 70 }} /></Field>
                <Field label="Stabilized NOI"><Input inputMode="decimal" value={pf.noi} onChange={(e) => setPf({ ...pf, noi: e.target.value })} style={{ width: 120 }} /></Field>
              </div>
              <Field label="Equity cash flows by year (out negative, in positive)" help="e.g. -3500000, 0, 0, 0, 0, 7000000"><Textarea rows={2} value={pf.flows} onChange={(e) => setPf({ ...pf, flows: e.target.value })} /></Field>
              {live && <p className="t-cap">Yield on cost {pctText(live.yieldOnCost, 2)} · LTC {pctText(live.ltc, 1)} · DSCR {live.dscr ?? '—'} · equity multiple {live.equityMultiple ?? '—'}× · IRR {live.irrAnnual == null ? '—' : pctText(live.irrAnnual, 2)}</p>}
              <Button variant="primary" disabled={!live || busy === 'pf'} onClick={() => void run('pf', url, { op: 'save_pro_forma', label: pf.label.trim() || 'Version', kind: pf.kind, inputs: { total_cost_cents: centsFrom(pf.cost), loan_cents: centsFrom(pf.loan) ?? 0, interest_rate: Number(pf.rate) / 100, noi_annual_cents: centsFrom(pf.noi) ?? 0, equity_cash_flows_cents: flows, periods_per_year: 1 } }, 'Saved the version')}>Save version</Button>
            </>
          )}
          {d.proFormas.length === 0 ? <p className="t-cap">No versions yet.</p> : (
            <table className="ops-mini" aria-label="Pro forma versions" style={{ marginTop: 12 }}>
              <thead><tr><th>Version</th><th className="n">Yield on cost</th><th className="n">LTC</th><th className="n">DSCR</th><th className="n">Multiple</th><th className="n">IRR</th><th /></tr></thead>
              <tbody>{d.proFormas.map((v) => <tr key={v.id}><td>{v.label}<div className="t-cap">{words(v.kind)} · {day(v.created_at, today)}{v.locked_at ? ' · locked' : ''}</div></td>
                <td className="n">{pctText(v.results?.yield_on_cost ?? null, 2)}</td><td className="n">{pctText(v.results?.ltc ?? null, 1)}</td><td className="n">{v.results?.dscr ?? '—'}</td><td className="n">{v.results?.equity_multiple ?? '—'}</td><td className="n">{pctText(v.results?.irr_annual ?? v.results?.irr_period ?? null, 2)}</td>
                <td>{!readOnly && !v.locked_at && <Button variant="quiet" disabled={busy === v.id} onClick={() => void run(v.id, url, { op: 'lock_pro_forma', id: v.id }, 'Locked the version')}>Lock</Button>}</td></tr>)}</tbody>
            </table>
          )}
        </Section>
      )}
      {tab === 'budget' && (
        <Section title="Budget" meta={d.grid ? `${count(d.grid.unmapped_lines)} lines not mapped to a lender line` : undefined}>
          {!d.grid ? <p className="t-cap">The budget needs job financials.</p> : d.grid.rows.length === 0 ? <Empty title="No budget yet" body="Approve the job's budget; each cost code then maps to a lender line, a CIP account and a category here." /> : (
            <>
              <div className="mp-table"><QueueTable aria-label="Budget" columns={gridCols} rows={d.grid.rows} getRowId={(r) => r.cost_code_id} rowState={(r) => ({ attn: r.variance_cents < 0 || r.lender_line_id == null })} /></div>
              <p className="t-cap" style={{ marginTop: 8 }}>Totals: at completion {money(d.grid.totals.ecac_cents ?? 0, { decimals: 0 })} · paid {money(d.grid.totals.paid_cents ?? 0, { decimals: 0 })} · drawn {money(d.grid.totals.drawn_cents ?? 0, { decimals: 0 })} · variance {money(d.grid.totals.variance_cents ?? 0, { decimals: 0 })}</p>
              {!readOnly && (
                <table className="ops-mini" aria-label="Lender and CIP mapping" style={{ marginTop: 12 }}>
                  <thead><tr><th>Cost code</th><th>Category</th><th>Contingency pool</th><th>Lender line</th><th>CIP account</th><th /></tr></thead>
                  <tbody>{d.grid.rows.map((r) => {
                    const m = map[r.cost_code_id] ?? { cat: r.category ?? 'HARD', pool: r.contingency_pool ?? '', line: r.lender_line_id ?? '', cip: r.cip_account_ref ?? '' };
                    const set = (patch: Partial<typeof m>) => setMap({ ...map, [r.cost_code_id]: { ...m, ...patch } });
                    return (
                      <tr key={r.cost_code_id}><td>{r.code} · {r.name}</td>
                        <td><Select aria-label="Category" value={m.cat} onChange={(e) => set({ cat: e.target.value })}>{CATS.map((c) => <option key={c} value={c}>{words(c)}</option>)}</Select></td>
                        <td>{m.cat === 'CONTINGENCY' ? <Select aria-label="Pool" value={m.pool} onChange={(e) => set({ pool: e.target.value })}><option value="HARD">Hard</option><option value="SOFT">Soft</option><option value="OWNER">Owner</option></Select> : ''}</td>
                        <td><Select aria-label="Lender line" value={m.line} onChange={(e) => set({ line: e.target.value })}><option value="">Not mapped</option>{d.lenderLines.map((l) => <option key={l.id} value={l.id}>{l.line_no} · {l.description}</option>)}</Select></td>
                        <td><Input aria-label="CIP account" value={m.cip} onChange={(e) => set({ cip: e.target.value })} style={{ width: 110 }} /></td>
                        <td>{map[r.cost_code_id] && <Button disabled={busy === r.cost_code_id} onClick={async () => { if (await run(r.cost_code_id, url, { op: 'map_line', costCodeId: r.cost_code_id, category: m.cat, pool: m.cat === 'CONTINGENCY' ? m.pool || 'HARD' : null, drawBudgetLineId: m.line || null, cipRef: m.cip || null }, 'Mapped')) { const n = { ...map }; delete n[r.cost_code_id]; setMap(n); } }}>Save</Button>}</td></tr>
                    );
                  })}</tbody>
                </table>
              )}
            </>
          )}
        </Section>
      )}
      {tab === 'sources' && (
        <>
          {d.balance && (
            <div className="dl-strip">
              <Figure dense label="Cost to complete" value={money(d.balance.cost_to_complete_cents, { decimals: 0 })} vs={[`total uses ${money(d.balance.total_uses_cents, { decimals: 0 })}`, 'cost at completion less paid']} href={`/development/${jobId}`} linkLabel="Budget" />
              <Figure dense label="Remaining sources" value={money(d.balance.remaining_sources_cents, { decimals: 0 })} vs={[`total sources ${money(d.balance.total_sources_cents, { decimals: 0 })}`, d.balance.interest_reserve_months != null ? `${qty(d.balance.interest_reserve_months)} months of interest reserve` : 'no interest reserve line']} href={`/development/${jobId}`} linkLabel="Sources" />
              <Figure dense label={d.balance.in_balance ? 'Cushion' : 'Gap'} value={money(Math.abs(d.balance.gap_cents), { decimals: 0 })} vs={[d.balance.in_balance ? 'in balance' : 'out of balance', 'remaining sources vs cost to complete']} href={`/development/${jobId}`} linkLabel="In-balance test" />
            </div>
          )}
          <Section title="Sources">
            {d.sources.length === 0 ? <p className="t-cap">No sources yet: add the loan and the equity.</p> : (
              <table className="ops-mini" aria-label="Sources"><thead><tr><th>Source</th><th>Rule</th><th className="n">Commitment</th><th className="n">Funded</th><th className="n">Remaining</th></tr></thead>
                <tbody>{d.sources.map((s) => { const bs = d.balance?.sources.find((x) => x.source_id === s.id); return <tr key={s.id}><td>{s.name}<div className="t-cap">{words(s.kind)} · rank {s.rank}</div></td><td>{words(s.funding_rule)}</td><td className="n">{money(s.commitment_cents, { decimals: 0 })}</td><td className="n">{money(s.funded_cents, { decimals: 0 })}{s.funded_as_of ? <div className="t-cap">as of {day(s.funded_as_of, today)}</div> : null}</td><td className={`n${bs?.over_commitment ? ' neg b' : ''}`}>{bs ? money(bs.remaining_cents, { decimals: 0 }) : '—'}</td></tr>; })}</tbody></table>
            )}
            {!readOnly && (
              <div className="ops-toolbar" style={{ marginTop: 8 }}>
                <Field label="Kind"><Select value={src.kind} onChange={(e) => setSrc({ ...src, kind: e.target.value })}>{['SENIOR_LOAN', 'MEZZ', 'PREF_EQUITY', 'SPONSOR_EQUITY', 'LP_EQUITY', 'TIF', 'GRANT', 'TAX_CREDIT', 'OTHER'].map((k) => <option key={k} value={k}>{words(k)}</option>)}</Select></Field>
                <Field label="Name"><Input value={src.name} onChange={(e) => setSrc({ ...src, name: e.target.value })} style={{ width: 200 }} /></Field>
                <Field label="Commitment"><Input inputMode="decimal" value={src.commit} onChange={(e) => setSrc({ ...src, commit: e.target.value })} style={{ width: 130 }} /></Field>
                <Field label="Funded"><Input inputMode="decimal" value={src.funded} onChange={(e) => setSrc({ ...src, funded: e.target.value })} style={{ width: 120 }} /></Field>
                <Field label="Rank"><Input inputMode="numeric" value={src.rank} onChange={(e) => setSrc({ ...src, rank: e.target.value })} style={{ width: 60 }} /></Field>
                <Field label="Rule"><Select value={src.rule} onChange={(e) => setSrc({ ...src, rule: e.target.value })}><option value="EQUITY_FIRST">Equity first</option><option value="PRO_RATA">Pro rata</option><option value="SEQUENCED">Sequenced</option></Select></Field>
                <Button disabled={!src.name.trim() || centsFrom(src.commit) == null || busy === 'src'} onClick={async () => { if (await run('src', url, { op: 'add_source', kind: src.kind, name: src.name.trim(), commitmentCents: centsFrom(src.commit), fundedCents: centsFrom(src.funded) ?? 0, rank: Number(src.rank) || 1, fundingRule: src.rule }, 'Added the source')) setSrc({ ...src, name: '', commit: '', funded: '' }); }}>Add source</Button>
              </div>
            )}
            {!readOnly && (
              <div className="ops-toolbar" style={{ marginTop: 8 }}>
                <Field label="Capital plan from"><Input type="date" value={plan.start} onChange={(e) => setPlan({ ...plan, start: e.target.value })} /></Field>
                <Field label="Months"><Input inputMode="numeric" value={plan.months} onChange={(e) => setPlan({ ...plan, months: e.target.value })} style={{ width: 60 }} /></Field>
                <Button variant="quiet" disabled={busy === 'plan'} onClick={() => void run('plan', url, { op: 'capital_plan', start: plan.start, months: Number(plan.months) || 12 }, 'Rebuilt the capital plan')}>Build capital plan</Button>
              </div>
            )}
          </Section>
        </>
      )}
      {tab === 'contingency' && (
        <Section title="Contingency" meta="Moves out of contingency are budget revisions that go through Approvals, with the lender's consent where the loan needs it">
          {!d.contingency ? <p className="t-cap">Contingency needs job financials.</p> : (
            <>
              <table className="ops-mini" aria-label="Pools"><thead><tr><th>Pool</th><th className="n">Original</th><th className="n">Used</th><th className="n">Left</th><th className="n">Burn</th><th className="n">Complete</th><th>Watch</th></tr></thead>
                <tbody>{d.contingency.pools.map((p) => <tr key={p.pool}><td>{words(p.pool)}</td><td className="n">{money(p.original_cents, { decimals: 0 })}</td><td className="n">{money(p.used_cents, { decimals: 0 })}</td><td className="n"><b>{money(p.current_cents, { decimals: 0 })}</b></td><td className="n">{pctText(p.burn_pct, 0)}</td><td className="n">{pctText(p.pct_complete, 0)}</td><td>{p.at_risk ? <Status kind="risk" pip="risk">Burning ahead of progress</Status> : <Status kind="ready" pip="ready">On pace</Status>}</td></tr>)}</tbody></table>
              {d.contingency.log.length > 0 && (
                <table className="ops-mini" aria-label="Reallocations" style={{ marginTop: 12 }}><thead><tr><th>When</th><th>Move</th><th className="n">Amount</th><th>Lender consent</th><th>Status</th><th /></tr></thead>
                  <tbody>{d.contingency.log.map((r) => (
                    <tr key={r.reallocation_id}><td>{day(r.created_at, today)}</td><td>{ccName(r.from)?.code ?? 'From'} → {ccName(r.to)?.code ?? 'To'}<div className="t-cap">{r.reason}</div></td><td className="n">{money(r.cents, { decimals: 0 })}</td>
                      <td>{!r.lender_consent_required ? 'Not needed' : r.lender_consent_ref ?? (readOnly || r.status !== 'PROPOSED' ? 'Waiting' : <ButtonRow><Input aria-label="Consent reference" value={consent[r.reallocation_id] ?? ''} onChange={(e) => setConsent({ ...consent, [r.reallocation_id]: e.target.value })} placeholder="Lender email, date, name" style={{ width: 200 }} /><Button disabled={!(consent[r.reallocation_id] ?? '').trim() || busy === `c${r.reallocation_id}`} onClick={() => void run(`c${r.reallocation_id}`, url, { op: 'lender_consent', reallocationId: r.reallocation_id, ref: consent[r.reallocation_id]!.trim() }, 'Recorded the lender consent')}>Record</Button></ButtonRow>)}</td>
                      <td>{words(r.status)}</td>
                      <td>{!readOnly && r.status === 'PROPOSED' && <ButtonRow>
                        <Button variant="primary" disabled={(r.lender_consent_required && !r.lender_consent_ref) || busy === r.reallocation_id} onClick={() => void run(r.reallocation_id, url, { op: 'approve_reallocation', reallocationId: r.reallocation_id }, (x: { status?: string }) => (x.status === 'approved' ? 'Approved the reallocation' : 'Sent to Approvals'))}>Approve</Button>
                        <Button variant="quiet" disabled={busy === r.reallocation_id} onClick={() => void run(r.reallocation_id, url, { op: 'cancel_reallocation', reallocationId: r.reallocation_id }, 'Cancelled')}>Cancel</Button>
                      </ButtonRow>}</td></tr>
                  ))}</tbody></table>
              )}
              {!readOnly && d.grid && (
                <div className="ops-toolbar" style={{ marginTop: 12 }}>
                  <Field label="From"><Select value={re.from} onChange={(e) => setRe({ ...re, from: e.target.value })}><option value="">Pick</option>{d.grid.rows.map((r) => <option key={r.cost_code_id} value={r.cost_code_id}>{r.code} · {r.name}</option>)}</Select></Field>
                  <Field label="To"><Select value={re.to} onChange={(e) => setRe({ ...re, to: e.target.value })}><option value="">Pick</option>{d.grid.rows.filter((r) => r.cost_code_id !== re.from).map((r) => <option key={r.cost_code_id} value={r.cost_code_id}>{r.code} · {r.name}</option>)}</Select></Field>
                  <Field label="Amount"><Input inputMode="decimal" value={re.amount} onChange={(e) => setRe({ ...re, amount: e.target.value })} style={{ width: 120 }} /></Field>
                  <Field label="Why"><Input value={re.reason} onChange={(e) => setRe({ ...re, reason: e.target.value })} style={{ width: 240 }} /></Field>
                  <Check label="Lender consent needed" checked={re.consent} onChange={(e) => setRe({ ...re, consent: e.target.checked })} />
                  <Button disabled={!re.from || !re.to || !(centsFrom(re.amount) ?? 0) || !re.reason.trim() || busy === 're'} onClick={async () => { if (await run('re', url, { op: 'propose_reallocation', fromCostCodeId: re.from, toCostCodeId: re.to, cents: centsFrom(re.amount), reason: re.reason.trim(), lenderConsentRequired: re.consent }, 'Proposed the reallocation')) setRe({ ...re, amount: '', reason: '' }); }}>Propose</Button>
                </div>
              )}
            </>
          )}
        </Section>
      )}
      {tab === 'draws' && (
        <Section title="Draws" meta={d.schedules.map((s) => `${s.lender_name}${s.loan_number ? ` ${s.loan_number}` : ''}`).join(' · ') || 'No lender schedule'}>
          {d.draws.length === 0 ? <Empty title="No draws yet" body="Open a draw on the lender schedule (Draws). Build it here from approved invoices, check it, and assemble the package in the lender's order." /> : (
            <table className="ops-mini" aria-label="Draws"><thead><tr><th>Draw</th><th>Period</th><th>Status</th><th className="n">Requested</th><th className="n">Approved</th></tr></thead>
              <tbody>{d.draws.map((x) => <tr key={x.id}><td><Link className="nlink" href={`/development/draws/${x.id}`}>Draw {x.draw_number}</Link></td><td>{day(x.period_end, today)}</td><td>{words(x.status)}</td><td className="n">{x.requested_cents == null ? '—' : money(x.requested_cents, { decimals: 0 })}</td><td className="n">{x.approved_cents == null ? '—' : money(x.approved_cents, { decimals: 0 })}</td></tr>)}</tbody></table>
          )}
          <p style={{ marginTop: 8 }}><Link className="link" href="/draws">Lender schedules and new draws</Link></p>
        </Section>
      )}
      {tab === 'investors' && (
        <Section title="Investors" meta="Read from Merit Books; nothing is kept here">
          {!d.investors ? <p className="t-cap">The investor view needs job financials.</p> : !d.investors.available ? <InlineNotice tone="info" title="Not available yet.">{d.investors.reason ?? 'Merit Books has not exposed the cap table for this SPE.'}</InlineNotice> : (
            <>
              <table className="ops-mini" aria-label="Holders"><thead><tr><th>Holder</th><th>Class</th><th className="n">Ownership</th><th className="n">Contributed</th></tr></thead>
                <tbody>{(d.investors.holders ?? []).map((h) => <tr key={h.name}><td>{h.name}{h.is_preferred ? <div className="t-cap">preferred</div> : null}</td><td>{words(h.equity_class)}</td><td className="n">{h.ownership_pct == null ? '—' : `${qty(h.ownership_pct)}%`}</td><td className="n">{h.capital_contributed_cents == null ? '—' : money(h.capital_contributed_cents, { decimals: 0 })}</td></tr>)}</tbody></table>
              <p className="t-cap" style={{ marginTop: 8 }}>Contributed {money(d.investors.contributed_cents ?? 0, { decimals: 0 })}. {d.investors.distributions && !d.investors.distributions.available ? `Distributions: ${d.investors.distributions.reason ?? 'not exposed by Merit Books yet'}.` : ''}</p>
            </>
          )}
        </Section>
      )}
    </div>
  );
}
