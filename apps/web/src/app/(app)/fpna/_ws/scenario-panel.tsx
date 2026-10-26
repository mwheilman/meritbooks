'use client';

/**
 * What-if in plain English (exceed X4, ported from the old /fpna onto merit-ui). The AI only
 * PARSES the sentence into levers (revenue growth, cost change, headcount); the scenario engine
 * computes best / base / worst on the company's driver budget. AI down → a keyword model,
 * said plainly. One company at a time: drivers live in a company's budget.
 */
import { useEffect, useState } from 'react';
import { Button, ButtonLink, InlineNotice, Tag, Textarea, api } from '@meritbooks/merit-ui';
import { formatValue } from '@/components/charts';
import type { BudgetDriver } from '@/lib/budget/drivers';
import s from './fpna.module.css';

type CaseKey = 'best' | 'base' | 'worst';
interface Levers {
  revenueGrowthPct: number;
  costChangePct: number;
  headcountDelta: number;
}
interface CaseSummary {
  revenueCents: number;
  netIncomeCents: number;
  endingCashCents: number;
  grossMarginBps: number;
}
interface NlResponse {
  parsed: { scenarioName: string; cases: Record<CaseKey, Levers>; assumptions: string[]; notes: string | null; confidence: number };
  result: Record<CaseKey, { summary: CaseSummary }>;
  meta: { source: 'ai' | 'heuristic'; model: string | null; message?: string | null };
}
interface AccountLite {
  id: string;
  accountNumber: string;
  accountType: string;
  isActive: boolean;
  approvalStatus: string;
}

const EXAMPLES = ['Raise revenue 8% and cut costs 12%', 'What if we lose our biggest customer', 'Hire 3 people and grow sales 10%'];
const COST_PER_HEAD_CENTS = 800_000;

export function ScenarioPanel({ companyId, companyName, fiscalYear }: { companyId: string | null; companyName: string | null; fiscalYear: number }) {
  const [drivers, setDrivers] = useState<BudgetDriver[] | null>(null);
  const [headAcct, setHeadAcct] = useState<string | undefined>();
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [resp, setResp] = useState<NlResponse | null>(null);

  useEffect(() => {
    setResp(null);
    if (!companyId) return;
    let cancelled = false;
    setLoading(true);
    setLoadErr(null);
    void (async () => {
      const [m, a] = await Promise.all([
        api.get<{ model: { drivers: BudgetDriver[] } | null }>('/api/budgets/drivers', { location_id: companyId, fiscal_year: String(fiscalYear) }),
        api.get<{ data: AccountLite[] }>('/api/accounts', { location_id: companyId }),
      ]);
      if (cancelled) return;
      setLoading(false);
      if (m.error) {
        setLoadErr(m.error.error);
        return;
      }
      const d = m.data?.model?.drivers ?? null;
      setDrivers(d && d.length ? d : null);
      setHeadAcct((a.data?.data ?? []).filter((x) => x.accountType === 'OPEX' && x.isActive && x.approvalStatus === 'APPROVED').sort((x, y) => x.accountNumber.localeCompare(y.accountNumber))[0]?.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, fiscalYear]);

  const run = async () => {
    if (!drivers || text.trim().length < 2) return;
    setBusy(true);
    setErr(null);
    const r = await api.post<NlResponse>('/api/fpna/nl-scenario', { text: text.trim(), baseDrivers: drivers, monthlyCostPerHeadCents: COST_PER_HEAD_CENTS, ...(headAcct ? { headcountAccountId: headAcct } : {}) });
    setBusy(false);
    if (r.error || !r.data) {
      setErr(r.error?.error ?? 'Could not model that scenario.');
      return;
    }
    setResp(r.data);
  };

  if (!companyId) {
    return <InlineNotice tone="info" title="Pick one company to model a what-if.">Scenarios run on a company’s driver-based budget.</InlineNotice>;
  }
  if (loading) return <div className={s.skeleton} aria-busy="true" style={{ height: 96 }} />;
  if (loadErr) return <InlineNotice tone="neg" title="Couldn’t load the plan.">{loadErr}</InlineNotice>;
  if (!drivers) {
    return (
      <InlineNotice tone="info" title={`No driver-based budget for ${companyName ?? 'this company'} (FY ${fiscalYear}) yet.`}>
        <ButtonLink href="/budgets/drivers">Build a driver budget</ButtonLink>
      </InlineNotice>
    );
  }
  return (
    <div>
      <div className={s.row}>
        <Textarea
          aria-label="Describe a what-if"
          rows={2}
          value={text}
          maxLength={400}
          placeholder="e.g. raise revenue 8% and cut costs 12%"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void run();
            }
          }}
          style={{ flex: '1 1 360px' }}
        />
        <Button variant="primary" onClick={() => void run()} disabled={busy || text.trim().length < 2} chord="mod+enter">{busy ? 'Modelling…' : 'Model it'}</Button>
      </div>
      <div className={s.groupRow}>
        {EXAMPLES.map((e) => (
          <Button key={e} variant="quiet" onClick={() => setText(e)}>{e}</Button>
        ))}
      </div>
      {err && <InlineNotice tone="neg" title="Not modelled.">{err}</InlineNotice>}
      {resp && (
        <div style={{ marginTop: 12 }}>
          <p>
            <b>{resp.parsed.scenarioName}</b> {resp.meta.source === 'heuristic' ? <Tag tone="warn">AI paused — keyword model</Tag> : <Tag tone="ai">Levers read by AI · figures by the engine</Tag>}
          </p>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Revenue growth</th>
                  <th>Cost change</th>
                  <th>Headcount</th>
                  <th>Revenue</th>
                  <th>Net income</th>
                  <th>Ending cash</th>
                  <th>Gross margin</th>
                </tr>
              </thead>
              <tbody>
                {(['best', 'base', 'worst'] as const).map((k) => {
                  const l = resp.parsed.cases[k];
                  const r = resp.result[k].summary;
                  return (
                    <tr key={k}>
                      <td>{k === 'best' ? 'Best' : k === 'base' ? 'Base' : 'Worst'}</td>
                      <td>{l.revenueGrowthPct.toFixed(1)}%</td>
                      <td>{l.costChangePct.toFixed(1)}%</td>
                      <td>{l.headcountDelta > 0 ? `+${l.headcountDelta}` : l.headcountDelta}</td>
                      <td>{formatValue(r.revenueCents, 'money', { compact: true })}</td>
                      <td>{formatValue(r.netIncomeCents, 'money', { compact: true })}</td>
                      <td>{formatValue(r.endingCashCents, 'money', { compact: true })}</td>
                      <td>{(r.grossMarginBps / 100).toFixed(1)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {resp.parsed.assumptions.length > 0 && (
            <ul className={s.bullets}>
              {resp.parsed.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
