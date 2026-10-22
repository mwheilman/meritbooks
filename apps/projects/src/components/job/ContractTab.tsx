'use client';

import { useState } from 'react';
import {
  Button, Field, Input, InlineNotice, MoneyInput, Select, StatementTable, Tag, WidgetState, count, money, pct,
  type StatementColumn,
} from '@meritbooks/merit-ui';
import { PROGRESS_BASIS_LABELS } from '@/lib/packs';
import type { ContractRow, ProgressBasis, ProgressSnapshotRow } from '@/lib/pm/types';
import { useMoneyVis, useShell } from '@/components/shell/ShellContext';
import { useAction } from './useAction';

export interface ContractTabProps {
  jobId: string;
  contracts: ContractRow[];
  snapshots: ProgressSnapshotRow[];
  originalCents: number;
  approvedCoCents: number;
  pendingCoCents: number;
  defaultBasis: ProgressBasis;
  booksPresent: boolean;
  isSample: boolean;
}

const BASES: ProgressBasis[] = ['NONE', 'COST_TO_COST', 'PHYSICAL_PCT', 'UNITS', 'MILESTONES'];
const COLS: StatementColumn[] = [{ id: 'v', header: 'Amount', current: true, width: 160 }];
const TRIGGER_WORDS: Record<string, string> = { CONTRACT_SET: 'Contract set', CHANGE_ORDER: 'Change order', PROGRESS_UPDATE: 'Progress', BUDGET_REVISED: 'Budget revised' };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Parse "12.5" (percent) → 0.125. Null when not a number in 0–100. */
export function parsePercent(text: string): number | null {
  const t = text.trim().replace(/%$/, '');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n >= 0 && n <= 100 ? Math.round(n * 100) / 10000 : null;
}

export function ContractTab(p: ContractTabProps) {
  const { readOnly } = useShell();
  // Contract-side tab; the snapshots' cost estimate needs financials too.
  const mv = useMoneyVis();
  const { run, busy } = useAction();
  const prime = p.contracts.find((c) => c.status === 'ACTIVE' && c.kind === 'PRIME') ?? p.contracts.find((c) => c.status === 'ACTIVE') ?? null;
  const [value, setValue] = useState<number | null>(prime?.original_cents ?? null);
  const [ret, setRet] = useState(prime?.retention_pct != null ? String(Math.round(prime.retention_pct * 10000) / 100) : '');
  const [basis, setBasis] = useState<ProgressBasis>(prime?.progress_basis ?? p.defaultBasis);
  const [pctText, setPctText] = useState(prime?.pct_complete != null ? String(Math.round(prime.pct_complete * 10000) / 100) : '');
  const [err, setErr] = useState<Record<string, string>>({});
  const physical = (prime?.progress_basis ?? basis) === 'PHYSICAL_PCT' || (prime?.progress_basis ?? basis) === 'UNITS';

  const save = async () => {
    const e: Record<string, string> = {};
    if (value == null) e.value = 'Enter the contract value.';
    const r = ret ? parsePercent(ret) : null;
    if (ret && (r == null || r > 0.2)) e.ret = 'Retention is 0 to 20 percent.';
    setErr(e);
    if (Object.keys(e).length) return;
    await run('contract', 'post', `/api/jobs/${p.jobId}/contract`, { originalCents: value, retentionPct: r, progressBasis: basis, contractId: prime?.id ?? null },
      p.booksPresent && !p.isSample ? 'Saved the contract and sent it to Merit Books' : 'Saved the contract');
  };
  const saveProgress = async () => {
    const f = parsePercent(pctText);
    if (f == null) return setErr({ pct: 'Enter a percent from 0 to 100.' });
    setErr({});
    await run('progress', 'post', `/api/jobs/${p.jobId}/progress`, { pct: f }, `Set progress to ${pct(f)}`);
  };

  return (
    <div className="grid-12" style={{ rowGap: 24, alignItems: 'start' }}>
      <section style={{ gridColumn: 'span 7' }} className="stack">
        <div className="sec">
          <div className="sec-h"><h2 className="t-section">Contract value</h2><span className="sp" /><span className="t-cap">In US dollars</span></div>
          <StatementTable
            aria-label="Contract value"
            unitLabel="Contract"
            columns={COLS}
            rows={[
              { kind: 'line', id: 'o', label: 'Original contract', values: [p.originalCents] },
              { kind: 'line', id: 'c', label: 'Approved change orders', values: [p.approvedCoCents] },
              { kind: 'grand', label: 'Revised contract', sumOf: ['o', 'c'], values: [p.originalCents + p.approvedCoCents] },
            ]}
            caption={p.pendingCoCents ? `${money(p.pendingCoCents)} in open change orders is not counted until approved.` : 'Totals tie.'}
          />
        </div>

        <div className="sec">
          <div className="sec-h"><h2 className="t-section">Sent to Merit Books</h2><span className="sp" /><span className="t-cap">Latest {count(p.snapshots.length)}</span></div>
          {p.snapshots.length === 0 ? (
            <WidgetState state={{ kind: 'empty', title: 'Nothing sent yet', body: 'Setting the contract, approving a change order or saving a budget revision sends a progress snapshot.' }} />
          ) : (
            <table className="tbl tbl-q tbl-q--compact">
              <colgroup><col style={{ width: 56 }} /><col style={{ width: 96 }} /><col /><col style={{ width: 128 }} />{mv.cost && <col style={{ width: 128 }} />}<col style={{ width: 72 }} /><col style={{ width: 120 }} /></colgroup>
              <thead><tr><th>Ver.</th><th>As of</th><th>Why</th><th className="n">Contract</th>{mv.cost && <th className="n">Cost estimate</th>}<th className="n">Done</th><th>Merit Books</th></tr></thead>
              <tbody>
                {p.snapshots.map((s) => (
                  <tr key={s.id} className="q-row">
                    <td className="n">v{s.snapshot_version}</td>
                    <td>{s.as_of_date}</td>
                    <td>{TRIGGER_WORDS[s.trigger_name] ?? s.trigger_name}</td>
                    <td className="n">{money(s.contract_value_cents)}</td>
                    {mv.cost && <td className="n">{money(s.cost_estimate_cents)}</td>}
                    <td className="n">{s.pct_complete == null ? '—' : pct(s.pct_complete)}</td>
                    <td>{s.emitted ? <Tag tone="pos">Sent</Tag> : <Tag>{s.suppressed_reason === 'SAMPLE' ? 'Sample, not sent' : 'Books off'}</Tag>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section style={{ gridColumn: 'span 5' }} className="stack">
        {!readOnly && (
          <div className="sec">
            <div className="sec-h"><h2 className="t-section">{prime ? 'Change the contract' : 'Set the contract'}</h2></div>
            <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
              <Field label="Original contract value" error={err.value} help="Approved change orders add to it automatically.">
                <MoneyInput valueCents={value} onChangeCents={setValue} placeholder="0.00" />
              </Field>
              <div className="mp-form-2">
                <Field label="Retention %" error={err.ret} help="Held back on each bill">
                  <Input inputMode="decimal" value={ret} onChange={(e) => setRet(e.target.value)} placeholder="0" />
                </Field>
                <Field label="Progress measured by">
                  <Select value={basis} onChange={(e) => setBasis(e.target.value as ProgressBasis)}>
                    {BASES.map((b) => <option key={b} value={b}>{cap(PROGRESS_BASIS_LABELS[b])}</option>)}
                  </Select>
                </Field>
              </div>
              {!p.booksPresent && <InlineNotice title="Merit Books is not on.">The contract is kept in Merit Projects; nothing is sent.</InlineNotice>}
              <div className="btn-row"><Button variant="primary" type="submit" disabled={busy === 'contract'}>{prime ? 'Save contract' : 'Set contract'}</Button></div>
            </form>
          </div>
        )}

        {prime && physical && !readOnly && (
          <div className="sec">
            <div className="sec-h"><h2 className="t-section">Percent complete</h2><span className="sp" />{prime.pct_complete != null && <span className="t-cap">Now {pct(prime.pct_complete)}</span>}</div>
            <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void saveProgress(); }}>
              <Field label="Physical percent complete" error={err.pct} help="Sent to Merit Books as the progress input for revenue.">
                <Input inputMode="decimal" value={pctText} onChange={(e) => setPctText(e.target.value)} placeholder="0" />
              </Field>
              <div className="btn-row"><Button type="submit" disabled={busy === 'progress'}>Save progress</Button></div>
            </form>
          </div>
        )}
        {prime && !physical && (
          <p className="t-cap">Progress is measured by {PROGRESS_BASIS_LABELS[prime.progress_basis]}; Merit Books works it out from posted cost, so there is nothing to enter here.</p>
        )}
      </section>
    </div>
  );
}
